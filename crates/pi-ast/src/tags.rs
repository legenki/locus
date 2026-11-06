//! locus: per-file symbol tags for the repository map and `edit_symbol`.
//!
//! One tree-sitter walk per file yields three lists:
//!
//! - **symbols** — definitions with a qualified name (`Class.method`,
//!   `Type.method` for Go receivers and Rust `impl` blocks), a kind, the full
//!   edit range (leading doc comments, decorators and attributes included) and
//!   a one-line signature;
//! - **imports** — module specifiers with the names they bind, re-exports,
//!   dynamic `import()`/`require()`, Rust `use` paths and `mod foo;` items;
//! - **refs** — call, constructor, macro and type references, each tied to the
//!   innermost enclosing symbol and deduplicated per `(enclosing, qualifier,
//!   name, kind)` with an occurrence count.
//!
//! Only TypeScript/TSX/JavaScript, Go and Rust are walked. Other languages
//! return `supported: false` and empty lists, so the caller can still index
//! the file as a node without symbols.
//!
//! Files are parsed without the shared [`crate::parse_cache`]: a full-repo
//! scan would evict the trees the editing hot path relies on.

use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::{
	language::{
		SupportLang,
		grammar::{self, LanguageGrammar},
	},
	summary::resolve_language,
};

/// Maximum signature length in characters (after whitespace collapse).
const MAX_SIGNATURE_CHARS: usize = 200;

/// Files above this size are not parsed (generated bundles, fixtures).
pub const MAX_TAGS_SOURCE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagsOptions {
	/// Source code to inspect.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolTag {
	/// Bare declared name (`fetch`).
	pub name:       String,
	/// Dotted container path plus name (`UserStore.fetch`).
	pub qname:      String,
	/// One of `function`, `method`, `class`, `struct`, `interface`, `trait`,
	/// `type`, `enum`, `const`, `var`, `module`, `macro`, `property`.
	pub kind:       String,
	/// 1-indexed inclusive first line of the edit range (leading docs,
	/// decorators and attributes included).
	pub start_line: u32,
	/// 1-indexed inclusive last line of the edit range.
	pub end_line:   u32,
	/// Byte offset of the edit range start.
	pub start_byte: u32,
	/// Byte offset one past the edit range end.
	pub end_byte:   u32,
	/// 1-indexed line of the declared name.
	pub name_line:  u32,
	/// Visible outside its module: `export`, Rust `pub`, Go capitalized name.
	pub exported:   bool,
	/// Declaration head with whitespace collapsed, body omitted.
	pub signature:  String,
	/// Index of the container symbol in `symbols`, if any.
	pub parent:     Option<u32>,
	/// Extra qualifier used to disambiguate members: the trait of a Rust
	/// `impl Trait for Type` block.
	pub detail:     Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportName {
	/// Name exported by the target module (`*` for namespace or glob imports,
	/// `default` for default imports).
	pub imported: String,
	/// Local binding (equals `imported` when not aliased).
	pub local:    String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportTag {
	/// Module specifier as written: `./a`, `@pkg/x`, `github.com/x/y`,
	/// `crate::a::b`, or a Rust `mod` name.
	pub specifier: String,
	/// `import`, `reexport`, `dynamic`, `use` or `mod`.
	pub kind:      String,
	/// Bound names; empty for side-effect, dynamic, Go and `mod` imports.
	pub names:     Vec<ImportName>,
	/// Go import alias (`.`/`_` included); `None` when absent.
	pub alias:     Option<String>,
	/// 1-indexed line of the import.
	pub line:      u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefTag {
	/// Referenced name (last path segment).
	pub name:      String,
	/// Leading path or receiver as written (`pkg`, `ns`, `crate::a`, `this`),
	/// `None` for bare names.
	pub qualifier: Option<String>,
	/// `call`, `new`, `macro` or `type`.
	pub kind:      String,
	/// Index of the innermost enclosing symbol in `symbols`.
	pub enclosing: Option<u32>,
	/// 1-indexed line of the first occurrence.
	pub line:      u32,
	/// Occurrences folded into this entry.
	pub count:     u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileTags {
	/// Canonical language name, `None` when unrecognized.
	pub language:   Option<String>,
	/// Whether the language has a tags walker.
	pub supported:  bool,
	/// Whether the tree contains ERROR or MISSING nodes.
	pub has_errors: bool,
	/// Total line count of the source.
	pub line_count: u32,
	pub symbols:    Vec<SymbolTag>,
	pub imports:    Vec<ImportTag>,
	pub refs:       Vec<RefTag>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
	Js,
	Go,
	Rust,
}

const fn family(lang: SupportLang) -> Option<Family> {
	match lang {
		SupportLang::JavaScript | SupportLang::TypeScript | SupportLang::Tsx => Some(Family::Js),
		SupportLang::Go => Some(Family::Go),
		SupportLang::Rust => Some(Family::Rust),
		_ => None,
	}
}

/// Extract symbols, imports and references from one file.
///
/// # Errors
/// When the grammar cannot be loaded or the parser rejects it.
pub fn extract_tags(options: TagsOptions) -> Result<FileTags> {
	let TagsOptions { code, lang, path } = options;
	let line_count = count_lines(&code);
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(FileTags { line_count, ..FileTags::default() });
	};
	let mut out = FileTags {
		language: Some(language.canonical_name().to_owned()),
		line_count,
		..FileTags::default()
	};
	let Some(fam) = family(language) else {
		return Ok(out);
	};
	out.supported = true;
	if code.is_empty() || code.len() > MAX_TAGS_SOURCE_BYTES {
		return Ok(out);
	}
	let ts_language = language.grammar().load()?;
	let Some(tree) = grammar::parse(&ts_language, &code, None)? else {
		return Ok(out);
	};
	let root = tree.root_node();
	out.has_errors = root.has_error();

	let mut walker = Walker {
		src: code.as_bytes(),
		fam,
		symbols: Vec::new(),
		imports: Vec::new(),
		refs: Vec::new(),
		ref_index: HashMap::new(),
	};
	walker.walk_children(root, &Ctx::default());
	out.symbols = walker.symbols;
	out.imports = walker.imports;
	out.refs = walker.refs;
	Ok(out)
}

fn count_lines(code: &str) -> u32 {
	if code.is_empty() {
		return 0;
	}
	let newlines = code.bytes().filter(|&b| b == b'\n').count() as u32;
	if code.ends_with('\n') { newlines } else { newlines + 1 }
}

/// Walk context: the enclosing symbol and the dotted container path.
#[derive(Clone, Default)]
struct Ctx {
	/// Innermost enclosing symbol (refs attach here).
	enclosing: Option<u32>,
	/// Container symbol for new declarations (class, module, impl target).
	parent:    Option<u32>,
	/// Dotted path prefix for qualified names.
	prefix:    String,
	/// Declarations here are exported regardless of their own modifiers
	/// (members of an exported TS namespace or class keep their own rules;
	/// this is only set by `export` wrappers).
	exported:  bool,
	/// Inside a function body: nested declarations are locals, not symbols.
	in_body:   bool,
	/// Trait of the enclosing Rust `impl Trait for Type`.
	detail:    Option<String>,
	/// Inside a Rust `impl` or `trait`: functions here are methods.
	type_container: bool,
}

type RefKey = (Option<u32>, Option<String>, String, &'static str);

struct Walker<'a> {
	src:       &'a [u8],
	fam:       Family,
	symbols:   Vec<SymbolTag>,
	imports:   Vec<ImportTag>,
	refs:      Vec<RefTag>,
	ref_index: HashMap<RefKey, usize>,
}

/// Declaration to record.
struct Decl<'t> {
	/// Node whose span is the edit range (before leading-trivia extension).
	range:    Node<'t>,
	/// Node that carries the declaration head (signature source).
	head:     Node<'t>,
	name:     String,
	name_row: usize,
	kind:     &'static str,
	exported: bool,
}

impl<'a> Walker<'a> {
	fn text(&self, node: Node) -> &'a str {
		node.utf8_text(self.src).unwrap_or("")
	}

	fn walk_children(&mut self, node: Node, ctx: &Ctx) {
		let mut cursor = node.walk();
		let children: Vec<Node> = node.named_children(&mut cursor).collect();
		for child in children {
			self.walk(child, ctx);
		}
	}

	/// Walk the children of `node` except `skip` (a declaration's own name).
	fn walk_children_except(&mut self, node: Node, skip: Option<Node>, ctx: &Ctx) {
		let mut cursor = node.walk();
		let children: Vec<Node> = node.named_children(&mut cursor).collect();
		for child in children {
			if skip.is_some_and(|s| s.id() == child.id()) {
				continue;
			}
			self.walk(child, ctx);
		}
	}

	fn walk(&mut self, node: Node, ctx: &Ctx) {
		let handled = match self.fam {
			Family::Js => self.js_node(node, ctx),
			Family::Go => self.go_node(node, ctx),
			Family::Rust => self.rust_node(node, ctx),
		};
		if !handled {
			self.collect_ref(node, ctx);
			self.walk_children(node, ctx);
		}
	}

	// ── Symbols ───────────────────────────────────────────────────────────

	fn push_symbol(&mut self, decl: &Decl, ctx: &Ctx) -> u32 {
		let start = self.leading_start(decl.range);
		let end_byte = decl.range.end_byte();
		let end_row = content_end_row(decl.range);
		let qname = if ctx.prefix.is_empty() {
			decl.name.clone()
		} else {
			format!("{}.{}", ctx.prefix, decl.name)
		};
		let signature = self.signature(decl.head);
		let index = self.symbols.len() as u32;
		self.symbols.push(SymbolTag {
			name: decl.name.clone(),
			qname,
			kind: decl.kind.to_owned(),
			start_line: start.1 as u32 + 1,
			end_line: end_row as u32 + 1,
			start_byte: start.0 as u32,
			end_byte: end_byte as u32,
			name_line: decl.name_row as u32 + 1,
			exported: decl.exported,
			signature,
			parent: ctx.parent,
			detail: ctx.detail.clone(),
		});
		index
	}

	/// Context for walking inside a declared symbol.
	fn inner_ctx(&self, ctx: &Ctx, index: u32, container: bool, body: bool) -> Ctx {
		let sym = &self.symbols[index as usize];
		Ctx {
			enclosing: Some(index),
			parent:    if container { Some(index) } else { ctx.parent },
			prefix:    if container { sym.qname.clone() } else { ctx.prefix.clone() },
			exported:  false,
			in_body:   body || ctx.in_body,
			detail:    if container { None } else { ctx.detail.clone() },
			type_container: false,
		}
	}

	/// Start of the edit range: extend over adjacent doc comments, decorators
	/// and attributes that precede `node` with no blank line in between.
	/// Returns `(byte, row)`.
	fn leading_start(&self, node: Node) -> (usize, usize) {
		let mut start = (node.start_byte(), node.start_position().row);
		let mut cur = node;
		while let Some(prev) = cur.prev_sibling() {
			if !self.is_leading_trivia(prev) {
				break;
			}
			if prev.end_position().row + 1 < start.1 {
				break; // blank line between
			}
			start = (prev.start_byte(), prev.start_position().row);
			cur = prev;
		}
		start
	}

	fn is_leading_trivia(&self, node: Node) -> bool {
		let text = self.text(node);
		match (self.fam, node.kind()) {
			(Family::Js, "comment") => text.starts_with("/**"),
			(Family::Js, "decorator") => true,
			(Family::Go, "comment") => true,
			(Family::Rust, "attribute_item") => true,
			(Family::Rust, "line_comment") => text.starts_with("///") && !text.starts_with("////"),
			(Family::Rust, "block_comment") => text.starts_with("/**") && !text.starts_with("/***"),
			_ => false,
		}
	}

	/// Declaration head: text from the first non-trivia child to the body,
	/// whitespace collapsed.
	fn signature(&self, head: Node) -> String {
		let mut start = head.start_byte();
		let mut cursor = head.walk();
		for child in head.children(&mut cursor) {
			match child.kind() {
				"decorator" | "comment" | "attribute_item" | "line_comment" | "block_comment" => {
					start = child.end_byte();
				},
				_ => break,
			}
		}
		let end = body_start(head).unwrap_or_else(|| head.end_byte());
		let raw = std::str::from_utf8(&self.src[start.min(end)..end]).unwrap_or("");
		// Single-line heads: keep only the first line of long initializers.
		let raw = if body_start(head).is_none() { raw.lines().next().unwrap_or("") } else { raw };
		let mut sig = String::with_capacity(raw.len().min(MAX_SIGNATURE_CHARS));
		let mut last_space = true;
		for ch in raw.chars() {
			if ch.is_whitespace() {
				if !last_space {
					sig.push(' ');
					last_space = true;
				}
			} else {
				sig.push(ch);
				last_space = false;
			}
		}
		// Multi-line parameter lists collapse to `( a, b, )`; tidy the brackets.
		let sig = sig
			.replace("( ", "(")
			.replace("< ", "<")
			.replace(", )", ")")
			.replace(",)", ")")
			.replace(" )", ")")
			.replace(", >", ">")
			.replace(" >", ">");
		let sig = sig.trim_end_matches([' ', '{', '=', ';']).trim_end();
		truncate_chars(sig, MAX_SIGNATURE_CHARS)
	}

	// ── References ────────────────────────────────────────────────────────

	fn push_ref(&mut self, name: &str, qualifier: Option<String>, kind: &'static str, row: usize, ctx: &Ctx) {
		if name.is_empty() {
			return;
		}
		let key: RefKey = (ctx.enclosing, qualifier.clone(), name.to_owned(), kind);
		if let Some(&i) = self.ref_index.get(&key) {
			self.refs[i].count += 1;
			return;
		}
		self.ref_index.insert(key, self.refs.len());
		self.refs.push(RefTag {
			name: name.to_owned(),
			qualifier,
			kind: kind.to_owned(),
			enclosing: ctx.enclosing,
			line: row as u32 + 1,
			count: 1,
		});
	}

	fn collect_ref(&mut self, node: Node, ctx: &Ctx) {
		match self.fam {
			Family::Js => self.js_ref(node, ctx),
			Family::Go => self.go_ref(node, ctx),
			Family::Rust => self.rust_ref(node, ctx),
		}
	}

	// ── TypeScript / JavaScript ───────────────────────────────────────────

	fn js_node(&mut self, node: Node, ctx: &Ctx) -> bool {
		match node.kind() {
			"import_statement" => {
				self.js_import(node);
				true
			},
			"export_statement" => self.js_export(node, ctx),
			"function_declaration" | "generator_function_declaration" | "function_signature" => {
				if ctx.in_body {
					return false; // local function inside a body
				}
				self.js_decl(node, node, "function", ctx.exported, ctx, false);
				true
			},
			"class_declaration" | "abstract_class_declaration" => {
				if ctx.in_body {
					return false;
				}
				self.js_decl(node, node, "class", ctx.exported, ctx, true);
				true
			},
			"interface_declaration" if !ctx.in_body => {
				self.js_decl(node, node, "interface", ctx.exported, ctx, true);
				true
			},
			"type_alias_declaration" if !ctx.in_body => {
				self.js_decl(node, node, "type", ctx.exported, ctx, false);
				true
			},
			"enum_declaration" if !ctx.in_body => {
				self.js_decl(node, node, "enum", ctx.exported, ctx, false);
				true
			},
			"internal_module" | "module" if !ctx.in_body => {
				self.js_decl(node, node, "module", ctx.exported, ctx, true);
				true
			},
			"lexical_declaration" | "variable_declaration" if !ctx.in_body => {
				self.js_variables(node, node, ctx);
				true
			},
			"method_definition" | "method_signature" | "abstract_method_signature" if ctx.parent.is_some() && !ctx.in_body => {
				self.js_decl(node, node, "method", false, ctx, false);
				true
			},
			"public_field_definition" | "field_definition" | "property_signature" if ctx.parent.is_some() && !ctx.in_body => {
				let name_node = node.child_by_field_name("name").or_else(|| node.child_by_field_name("property"));
				let Some(name_node) = name_node else { return false };
				let decl = Decl {
					range: node,
					head: node,
					name: self.text(name_node).to_owned(),
					name_row: name_node.start_position().row,
					kind: "property",
					exported: false,
				};
				let index = self.push_symbol(&decl, ctx);
				let inner = self.inner_ctx(ctx, index, false, true);
				self.walk_children_except(node, Some(name_node), &inner);
				true
			},
			"call_expression" => {
				if let Some(spec) = self.js_dynamic_import(node) {
					self.imports.push(ImportTag {
						specifier: spec,
						kind:      "dynamic".to_owned(),
						names:     Vec::new(),
						alias:     None,
						line:      node.start_position().row as u32 + 1,
					});
				}
				false
			},
			_ => false,
		}
	}

	/// Record a JS/TS declaration and walk its body.
	fn js_decl(&mut self, range: Node, node: Node, kind: &'static str, exported: bool, ctx: &Ctx, container: bool) {
		let Some(name_node) = node.child_by_field_name("name") else {
			self.walk_children(node, ctx);
			return;
		};
		let decl = Decl {
			range,
			head: node,
			name: self.text(name_node).to_owned(),
			name_row: name_node.start_position().row,
			kind,
			exported,
		};
		let index = self.push_symbol(&decl, ctx);
		let is_fn = matches!(kind, "function" | "method");
		let inner = self.inner_ctx(ctx, index, container, is_fn);
		self.walk_children_except(node, Some(name_node), &inner);
	}

	/// `const a = …, b = …` — one symbol per simple-identifier declarator.
	fn js_variables(&mut self, range: Node, node: Node, ctx: &Ctx) {
		let is_const = node.child(0).is_some_and(|c| self.text(c) == "const");
		let mut cursor = node.walk();
		let declarators: Vec<Node> = node
			.named_children(&mut cursor)
			.filter(|c| c.kind() == "variable_declarator")
			.collect();
		let single = declarators.len() == 1;
		for d in declarators {
			let Some(name_node) = d.child_by_field_name("name").filter(|n| n.kind() == "identifier") else {
				self.walk_children(d, ctx);
				continue;
			};
			let value = d.child_by_field_name("value");
			let is_fn = value.is_some_and(|v| {
				matches!(v.kind(), "arrow_function" | "function_expression" | "function" | "generator_function")
			});
			let kind = if is_fn {
				"function"
			} else if is_const {
				"const"
			} else {
				"var"
			};
			let decl = Decl {
				// A lone declarator owns the whole statement (`export const x = …;`);
				// the signature starts at `const`, like functions start at `function`.
				range: if single { range } else { d },
				head: if single { node } else { d },
				name: self.text(name_node).to_owned(),
				name_row: name_node.start_position().row,
				kind,
				exported: ctx.exported,
			};
			let index = self.push_symbol(&decl, ctx);
			let inner = self.inner_ctx(ctx, index, false, true);
			self.walk_children_except(d, Some(name_node), &inner);
		}
	}

	fn js_export(&mut self, node: Node, ctx: &Ctx) -> bool {
		let source = node.child_by_field_name("source").map(|s| self.js_string(s));
		if let Some(spec) = source {
			// Re-export: `export { a as b } from "x"` / `export * from "x"`.
			let mut names = Vec::new();
			let mut cursor = node.walk();
			for child in node.named_children(&mut cursor) {
				match child.kind() {
					"export_clause" => names.extend(self.js_specifiers(child, "export_specifier")),
					"namespace_export" => {
						let local = child.named_child(0).map_or("*", |n| self.text(n)).to_owned();
						names.push(ImportName { imported: "*".to_owned(), local });
					},
					_ => {},
				}
			}
			if names.is_empty() {
				names.push(ImportName { imported: "*".to_owned(), local: "*".to_owned() });
			}
			self.imports.push(ImportTag {
				specifier: spec,
				kind: "reexport".to_owned(),
				names,
				alias: None,
				line: node.start_position().row as u32 + 1,
			});
			return true;
		}
		let Some(decl) = node.child_by_field_name("declaration") else {
			// `export default expr` / `export { a }`: walk for refs only.
			return false;
		};
		let exported_ctx = Ctx { exported: true, ..ctx.clone() };
		match decl.kind() {
			"function_declaration" | "generator_function_declaration" | "function_signature" => {
				self.js_decl(node, decl, "function", true, &exported_ctx, false);
			},
			"class_declaration" | "abstract_class_declaration" => {
				self.js_decl(node, decl, "class", true, &exported_ctx, true);
			},
			"interface_declaration" => self.js_decl(node, decl, "interface", true, &exported_ctx, true),
			"type_alias_declaration" => self.js_decl(node, decl, "type", true, &exported_ctx, false),
			"enum_declaration" => self.js_decl(node, decl, "enum", true, &exported_ctx, false),
			"internal_module" | "module" => self.js_decl(node, decl, "module", true, &exported_ctx, true),
			"lexical_declaration" | "variable_declaration" => self.js_variables(node, decl, &exported_ctx),
			_ => self.walk(decl, &exported_ctx),
		}
		true
	}

	fn js_import(&mut self, node: Node) {
		let Some(source) = node.child_by_field_name("source") else { return };
		let specifier = self.js_string(source);
		let mut names = Vec::new();
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if child.kind() != "import_clause" {
				continue;
			}
			let mut c2 = child.walk();
			for part in child.named_children(&mut c2) {
				match part.kind() {
					"identifier" => {
						names.push(ImportName { imported: "default".to_owned(), local: self.text(part).to_owned() });
					},
					"namespace_import" => {
						let local = part.named_child(0).map_or("*", |n| self.text(n)).to_owned();
						names.push(ImportName { imported: "*".to_owned(), local });
					},
					"named_imports" => names.extend(self.js_specifiers(part, "import_specifier")),
					_ => {},
				}
			}
		}
		self.imports.push(ImportTag {
			specifier,
			kind: "import".to_owned(),
			names,
			alias: None,
			line: node.start_position().row as u32 + 1,
		});
	}

	fn js_specifiers(&self, list: Node, kind: &str) -> Vec<ImportName> {
		let mut out = Vec::new();
		let mut cursor = list.walk();
		for spec in list.named_children(&mut cursor) {
			if spec.kind() != kind {
				continue;
			}
			let Some(name) = spec.child_by_field_name("name") else { continue };
			let imported = self.js_name(name);
			let local = spec.child_by_field_name("alias").map_or_else(|| imported.clone(), |a| self.js_name(a));
			out.push(ImportName { imported, local });
		}
		out
	}

	/// Identifier text, or the content of a string-literal export name.
	fn js_name(&self, node: Node) -> String {
		if node.kind() == "string" { self.js_string(node) } else { self.text(node).to_owned() }
	}

	fn js_string(&self, node: Node) -> String {
		let raw = self.text(node);
		raw.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_owned()
	}

	/// `import("x")` / `require("x")` with a literal argument.
	fn js_dynamic_import(&self, node: Node) -> Option<String> {
		let func = node.child_by_field_name("function")?;
		let is_import = func.kind() == "import" || (func.kind() == "identifier" && self.text(func) == "require");
		if !is_import {
			return None;
		}
		let args = node.child_by_field_name("arguments")?;
		let first = args.named_child(0)?;
		(first.kind() == "string").then(|| self.js_string(first))
	}

	fn js_ref(&mut self, node: Node, ctx: &Ctx) {
		let row = node.start_position().row;
		match node.kind() {
			"call_expression" => {
				let Some(func) = node.child_by_field_name("function") else { return };
				match func.kind() {
					"identifier" => {
						let name = self.text(func);
						if name != "require" {
							self.push_ref(name, None, "call", row, ctx);
						}
					},
					"member_expression" => {
						if let (Some(obj), Some(prop)) =
							(func.child_by_field_name("object"), func.child_by_field_name("property"))
						{
							let q = Some(self.text(obj).to_owned()).filter(|q| q.len() <= 80);
							self.push_ref(self.text(prop), q, "call", row, ctx);
						}
					},
					_ => {},
				}
			},
			"new_expression" => {
				if let Some(ctor) = node.child_by_field_name("constructor") {
					self.js_named_ref(ctor, "new", ctx);
				}
			},
			"type_identifier" => {
				// Declaration names are skipped by the declaration handlers.
				self.push_ref(self.text(node), None, "type", row, ctx);
			},
			"nested_type_identifier" => {
				if let (Some(m), Some(n)) = (node.child_by_field_name("module"), node.child_by_field_name("name")) {
					self.push_ref(self.text(n), Some(self.text(m).to_owned()), "type", row, ctx);
				}
			},
			"extends_clause" | "class_heritage" => {
				if let Some(v) = node.child_by_field_name("value") {
					self.js_named_ref(v, "type", ctx);
				}
			},
			"jsx_opening_element" | "jsx_self_closing_element" => {
				if let Some(n) = node.child_by_field_name("name") {
					let text = self.text(n);
					if text.starts_with(|c: char| c.is_ascii_uppercase()) {
						self.js_named_ref(n, "new", ctx);
					}
				}
			},
			_ => {},
		}
	}

	/// Ref to an identifier or `a.b.c` member chain.
	fn js_named_ref(&mut self, node: Node, kind: &'static str, ctx: &Ctx) {
		let row = node.start_position().row;
		match node.kind() {
			"identifier" | "type_identifier" => self.push_ref(self.text(node), None, kind, row, ctx),
			"member_expression" | "nested_identifier" | "jsx_namespace_name" => {
				let text = self.text(node);
				if let Some((q, n)) = text.rsplit_once('.') {
					self.push_ref(n, Some(q.to_owned()), kind, row, ctx);
				}
			},
			_ => {},
		}
	}

	// ── Go ────────────────────────────────────────────────────────────────

	fn go_node(&mut self, node: Node, ctx: &Ctx) -> bool {
		match node.kind() {
			"import_declaration" => {
				self.go_imports(node);
				true
			},
			"function_declaration" if !ctx.in_body => {
				self.go_decl(node, node.child_by_field_name("name"), "function", ctx);
				true
			},
			"method_declaration" if !ctx.in_body => {
				let receiver = node
					.child_by_field_name("receiver")
					.and_then(|r| self.go_receiver_type(r));
				let parent = receiver
					.as_deref()
					.and_then(|recv| self.find_top_level(recv, &["struct", "interface", "type"]));
				let method_ctx = Ctx {
					parent,
					prefix: receiver.unwrap_or_default(),
					..ctx.clone()
				};
				self.go_decl(node, node.child_by_field_name("name"), "method", &method_ctx);
				true
			},
			"type_declaration" if !ctx.in_body => {
				let mut cursor = node.walk();
				let specs: Vec<Node> = node
					.named_children(&mut cursor)
					.filter(|c| matches!(c.kind(), "type_spec" | "type_alias"))
					.collect();
				let single = specs.len() == 1;
				for spec in specs {
					let kind = match spec.child_by_field_name("type").map(|t| t.kind()) {
						Some("struct_type") => "struct",
						Some("interface_type") => "interface",
						_ => "type",
					};
					let range = if single { node } else { spec };
					self.go_type_spec(range, spec, kind, ctx);
				}
				true
			},
			"const_declaration" | "var_declaration" if !ctx.in_body => {
				let kind = if node.kind() == "const_declaration" { "const" } else { "var" };
				let specs = collect_descendants(node, &["const_spec", "var_spec"]);
				let single = specs.len() == 1;
				for spec in specs {
					let mut cursor = spec.walk();
					let names: Vec<Node> = spec
						.children_by_field_name("name", &mut cursor)
						.filter(|n| n.kind() == "identifier")
						.collect();
					for name_node in &names {
						let name = self.text(*name_node).to_owned();
						let decl = Decl {
							range: if single && names.len() == 1 { node } else { spec },
							head: spec,
							exported: is_go_exported(&name),
							name,
							name_row: name_node.start_position().row,
							kind,
						};
						let index = self.push_symbol(&decl, ctx);
						let inner = self.inner_ctx(ctx, index, false, true);
						if let Some(v) = spec.child_by_field_name("value") {
							self.walk(v, &inner);
						}
						if let Some(t) = spec.child_by_field_name("type") {
							self.walk(t, &inner);
						}
					}
				}
				true
			},
			_ => false,
		}
	}

	fn go_decl(&mut self, node: Node, name_node: Option<Node>, kind: &'static str, ctx: &Ctx) {
		let Some(name_node) = name_node else {
			self.walk_children(node, ctx);
			return;
		};
		let name = self.text(name_node).to_owned();
		let decl = Decl {
			range: node,
			head: node,
			exported: is_go_exported(&name),
			name,
			name_row: name_node.start_position().row,
			kind,
		};
		let index = self.push_symbol(&decl, ctx);
		let inner = self.inner_ctx(ctx, index, false, true);
		self.walk_children_except(node, Some(name_node), &inner);
	}

	fn go_type_spec(&mut self, range: Node, spec: Node, kind: &'static str, ctx: &Ctx) {
		let Some(name_node) = spec.child_by_field_name("name") else { return };
		let name = self.text(name_node).to_owned();
		let decl = Decl {
			range,
			head: spec,
			exported: is_go_exported(&name),
			name,
			name_row: name_node.start_position().row,
			kind,
		};
		let index = self.push_symbol(&decl, ctx);
		let container = self.inner_ctx(ctx, index, true, false);
		let Some(ty) = spec.child_by_field_name("type") else { return };
		if ty.kind() == "interface_type" {
			let mut cursor = ty.walk();
			let members: Vec<Node> = ty.named_children(&mut cursor).collect();
			for m in members {
				if matches!(m.kind(), "method_elem" | "method_spec") {
					let Some(mname) = m.child_by_field_name("name") else { continue };
					let name = self.text(mname).to_owned();
					let decl = Decl {
						range: m,
						head: m,
						exported: is_go_exported(&name),
						name,
						name_row: mname.start_position().row,
						kind: "method",
					};
					let mi = self.push_symbol(&decl, &container);
					let inner = self.inner_ctx(&container, mi, false, true);
					self.walk_children_except(m, Some(mname), &inner);
				} else {
					self.walk(m, &container);
				}
			}
		} else {
			let inner = Ctx { in_body: true, ..container };
			self.walk(ty, &inner);
		}
	}

	/// Receiver base type name: `(s *Store)` → `Store`, `(l List[T])` → `List`.
	fn go_receiver_type(&self, receiver: Node) -> Option<String> {
		let param = collect_descendants(receiver, &["parameter_declaration"]).into_iter().next()?;
		let mut ty = param.child_by_field_name("type")?;
		loop {
			match ty.kind() {
				"pointer_type" => ty = ty.named_child(0)?,
				"generic_type" => ty = ty.child_by_field_name("type")?,
				"type_identifier" => return Some(self.text(ty).to_owned()),
				_ => return None,
			}
		}
	}

	fn go_imports(&mut self, node: Node) {
		for spec in collect_descendants(node, &["import_spec"]) {
			let Some(path) = spec.child_by_field_name("path") else { continue };
			let specifier = self.text(path).trim_matches(|c| c == '"' || c == '`').to_owned();
			let alias = spec.child_by_field_name("name").map(|n| self.text(n).to_owned());
			self.imports.push(ImportTag {
				specifier,
				kind: "import".to_owned(),
				names: Vec::new(),
				alias,
				line: spec.start_position().row as u32 + 1,
			});
		}
	}

	fn go_ref(&mut self, node: Node, ctx: &Ctx) {
		let row = node.start_position().row;
		match node.kind() {
			"call_expression" => {
				let Some(func) = node.child_by_field_name("function") else { return };
				match func.kind() {
					"identifier" => self.push_ref(self.text(func), None, "call", row, ctx),
					"selector_expression" => {
						if let (Some(op), Some(field)) =
							(func.child_by_field_name("operand"), func.child_by_field_name("field"))
						{
							let q = Some(self.text(op).to_owned()).filter(|q| q.len() <= 80);
							self.push_ref(self.text(field), q, "call", row, ctx);
						}
					},
					_ => {},
				}
			},
			"type_identifier" => self.push_ref(self.text(node), None, "type", row, ctx),
			"qualified_type" => {
				if let (Some(p), Some(n)) = (node.child_by_field_name("package"), node.child_by_field_name("name")) {
					self.push_ref(self.text(n), Some(self.text(p).to_owned()), "type", row, ctx);
				}
			},
			_ => {},
		}
	}

	// ── Rust ──────────────────────────────────────────────────────────────

	fn rust_node(&mut self, node: Node, ctx: &Ctx) -> bool {
		if ctx.in_body && !matches!(node.kind(), "use_declaration") {
			return false;
		}
		match node.kind() {
			"use_declaration" => {
				if let Some(arg) = node.child_by_field_name("argument") {
					let line = node.start_position().row as u32 + 1;
					self.rust_use_tree(arg, "", line);
				}
				true
			},
			"function_item" | "function_signature_item" => {
				let kind = if ctx.parent.is_some() && ctx.prefix_is_type() { "method" } else { "function" };
				self.rust_decl(node, kind, ctx, false);
				true
			},
			"struct_item" | "union_item" => {
				self.rust_decl(node, "struct", ctx, false);
				true
			},
			"enum_item" => {
				self.rust_decl(node, "enum", ctx, false);
				true
			},
			"trait_item" => {
				self.rust_decl(node, "trait", ctx, true);
				true
			},
			"type_item" => {
				self.rust_decl(node, "type", ctx, false);
				true
			},
			"const_item" | "static_item" => {
				self.rust_decl(node, "const", ctx, false);
				true
			},
			"macro_definition" => {
				self.rust_decl(node, "macro", ctx, false);
				true
			},
			"mod_item" => {
				if node.child_by_field_name("body").is_none() {
					if let Some(name) = node.child_by_field_name("name") {
						self.imports.push(ImportTag {
							specifier: self.text(name).to_owned(),
							kind:      "mod".to_owned(),
							names:     Vec::new(),
							alias:     None,
							line:      node.start_position().row as u32 + 1,
						});
					}
					return true;
				}
				self.rust_decl(node, "module", ctx, true);
				true
			},
			"impl_item" => {
				self.rust_impl(node, ctx);
				true
			},
			_ => false,
		}
	}

	fn rust_decl(&mut self, node: Node, kind: &'static str, ctx: &Ctx, container: bool) {
		let Some(name_node) = node.child_by_field_name("name") else {
			self.walk_children(node, ctx);
			return;
		};
		let exported = ctx.exported || has_child_kind(node, "visibility_modifier");
		let decl = Decl {
			range: node,
			head: node,
			name: self.text(name_node).to_owned(),
			name_row: name_node.start_position().row,
			kind,
			exported,
		};
		let index = self.push_symbol(&decl, ctx);
		let body = matches!(kind, "function" | "method" | "const" | "type" | "macro" | "struct" | "enum");
		let mut inner = self.inner_ctx(ctx, index, container, body);
		if kind == "trait" {
			inner.type_container = true;
			// Trait methods are part of the trait's public surface.
			inner.exported = exported;
		}
		self.walk_children_except(node, Some(name_node), &inner);
	}

	/// `impl [Trait for] Type { … }`: members become `Type.member`, with the
	/// trait kept in `detail`. The impl block itself is not a symbol.
	fn rust_impl(&mut self, node: Node, ctx: &Ctx) {
		let Some(ty) = node.child_by_field_name("type") else { return };
		let type_name = rust_type_base(ty).map(|n| self.text(n).to_owned());
		let trait_name = node
			.child_by_field_name("trait")
			.and_then(rust_type_base)
			.map(|n| self.text(n).to_owned());
		// The impl header names types: record them as refs from the container.
		self.walk(ty, ctx);
		if let Some(t) = node.child_by_field_name("trait") {
			self.walk(t, ctx);
		}
		let Some(type_name) = type_name else { return };
		let parent = self.find_top_level(&type_name, &["struct", "enum", "trait", "type"]);
		let prefix = if ctx.prefix.is_empty() { type_name } else { format!("{}.{type_name}", ctx.prefix) };
		let impl_ctx = Ctx {
			enclosing: ctx.enclosing,
			parent,
			prefix,
			exported: trait_name.is_some(),
			in_body: false,
			detail: trait_name,
			type_container: true,
		};
		if let Some(body) = node.child_by_field_name("body") {
			self.walk_children(body, &impl_ctx);
		}
	}

	/// Flatten a `use` tree into import tags; `prefix` is the path so far.
	fn rust_use_tree(&mut self, node: Node, prefix: &str, line: u32) {
		let join = |a: &str, b: &str| if a.is_empty() { b.to_owned() } else { format!("{a}::{b}") };
		match node.kind() {
			"scoped_use_list" => {
				let path = node.child_by_field_name("path").map_or(String::new(), |p| self.text(p).to_owned());
				let base = join(prefix, &path);
				if let Some(list) = node.child_by_field_name("list") {
					self.rust_use_tree(list, &base, line);
				}
			},
			"use_list" => {
				let mut cursor = node.walk();
				let items: Vec<Node> = node.named_children(&mut cursor).collect();
				for item in items {
					self.rust_use_tree(item, prefix, line);
				}
			},
			"use_as_clause" => {
				let Some(path) = node.child_by_field_name("path") else { return };
				let alias = node.child_by_field_name("alias").map(|a| self.text(a).to_owned());
				let full = join(prefix, self.text(path));
				self.rust_push_use(&full, alias, line);
			},
			"use_wildcard" => {
				let text = self.text(node).trim_end_matches("::*").trim_end_matches('*');
				let full = join(prefix, text.trim_end_matches("::"));
				self.imports.push(ImportTag {
					specifier: full,
					kind: "use".to_owned(),
					names: vec![ImportName { imported: "*".to_owned(), local: "*".to_owned() }],
					alias: None,
					line,
				});
			},
			"scoped_identifier" | "identifier" | "crate" | "self" | "super" => {
				let full = join(prefix, self.text(node));
				self.rust_push_use(&full, None, line);
			},
			_ => {},
		}
	}

	fn rust_push_use(&mut self, full: &str, alias: Option<String>, line: u32) {
		let (spec, last) = full.rsplit_once("::").unwrap_or(("", full));
		let (spec, imported) = if last == "self" {
			// `use a::b::{self}` binds `b`.
			spec.rsplit_once("::").map_or((String::new(), spec.to_owned()), |(s, l)| (s.to_owned(), l.to_owned()))
		} else {
			(spec.to_owned(), last.to_owned())
		};
		let local = alias.unwrap_or_else(|| imported.clone());
		self.imports.push(ImportTag {
			specifier: spec,
			kind: "use".to_owned(),
			names: vec![ImportName { imported, local }],
			alias: None,
			line,
		});
	}

	fn rust_ref(&mut self, node: Node, ctx: &Ctx) {
		let row = node.start_position().row;
		match node.kind() {
			"call_expression" => {
				let Some(mut func) = node.child_by_field_name("function") else { return };
				if func.kind() == "generic_function" {
					let Some(inner) = func.child_by_field_name("function") else { return };
					func = inner;
				}
				match func.kind() {
					"identifier" => self.push_ref(self.text(func), None, "call", row, ctx),
					"scoped_identifier" => {
						let name = func.child_by_field_name("name").map_or("", |n| self.text(n));
						let path = func.child_by_field_name("path").map(|p| self.text(p).to_owned());
						self.push_ref(name, path, "call", row, ctx);
					},
					"field_expression" => {
						if let (Some(v), Some(f)) = (func.child_by_field_name("value"), func.child_by_field_name("field"))
						{
							let q = Some(self.text(v).to_owned()).filter(|q| q.len() <= 80);
							self.push_ref(self.text(f), q, "call", row, ctx);
						}
					},
					_ => {},
				}
			},
			"macro_invocation" => {
				if let Some(m) = node.child_by_field_name("macro") {
					let text = self.text(m);
					let (q, n) = text.rsplit_once("::").map_or((None, text), |(q, n)| (Some(q.to_owned()), n));
					self.push_ref(n, q, "macro", row, ctx);
				}
			},
			"type_identifier" => self.push_ref(self.text(node), None, "type", row, ctx),
			"scoped_type_identifier" => {
				if let Some(n) = node.child_by_field_name("name") {
					let path = node.child_by_field_name("path").map(|p| self.text(p).to_owned());
					self.push_ref(self.text(n), path, "type", row, ctx);
				}
			},
			_ => {},
		}
	}

	// ── Shared ────────────────────────────────────────────────────────────

	/// Index of a top-level symbol named `name` with one of `kinds`.
	fn find_top_level(&self, name: &str, kinds: &[&str]) -> Option<u32> {
		self.symbols
			.iter()
			.position(|s| s.parent.is_none() && s.name == name && kinds.contains(&s.kind.as_str()))
			.map(|i| i as u32)
	}
}

impl Ctx {
	/// Whether functions declared here are methods (inside an `impl`/`trait`).
	const fn prefix_is_type(&self) -> bool {
		self.type_container
	}
}

fn is_go_exported(name: &str) -> bool {
	name.starts_with(|c: char| c.is_uppercase())
}

fn has_child_kind(node: Node, kind: &str) -> bool {
	let mut cursor = node.walk();
	node.children(&mut cursor).any(|c| c.kind() == kind)
}

/// Base type identifier of a Rust type: `Foo`, `Foo<T>`, `a::Foo`, `&Foo`.
fn rust_type_base(node: Node) -> Option<Node> {
	match node.kind() {
		"type_identifier" => Some(node),
		"generic_type" => node.child_by_field_name("type").and_then(rust_type_base),
		"scoped_type_identifier" => node.child_by_field_name("name"),
		"reference_type" | "pointer_type" => node.child_by_field_name("type").and_then(rust_type_base),
		_ => None,
	}
}

/// All descendants of the given kinds, in document order, not descending into
/// matches.
fn collect_descendants<'t>(node: Node<'t>, kinds: &[&str]) -> Vec<Node<'t>> {
	let mut out = Vec::new();
	let mut stack = vec![node];
	while let Some(n) = stack.pop() {
		let mut cursor = n.walk();
		let children: Vec<Node> = n.named_children(&mut cursor).collect();
		for child in children.into_iter().rev() {
			if kinds.contains(&child.kind()) {
				out.push(child);
			} else {
				stack.push(child);
			}
		}
	}
	out.sort_by_key(|n| n.start_byte());
	out
}

/// Start byte of the node's body (`body` field), if it has one.
fn body_start(node: Node) -> Option<usize> {
	if let Some(body) = node.child_by_field_name("body") {
		return Some(body.start_byte());
	}
	// `const f = () => {…}`: cut before the arrow body.
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if child.kind() == "variable_declarator"
			&& let Some(value) = child.child_by_field_name("value")
				&& let Some(b) = value.child_by_field_name("body") {
					return Some(b.start_byte());
				}
	}
	if let Some(value) = node.child_by_field_name("value")
		&& let Some(b) = value.child_by_field_name("body") {
			return Some(b.start_byte());
		}
	None
}

/// Last row holding node content: a node ending at column 0 of the next row
/// (trailing newline inside the node) ends on the previous row.
fn content_end_row(node: Node) -> usize {
	let end = node.end_position();
	if end.column == 0 && end.row > node.start_position().row { end.row - 1 } else { end.row }
}

fn truncate_chars(text: &str, max: usize) -> String {
	match text.char_indices().nth(max) {
		Some((idx, _)) => format!("{}…", &text[..idx]),
		None => text.to_owned(),
	}
}

#[cfg(test)]
mod tests;
