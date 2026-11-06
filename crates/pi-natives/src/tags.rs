//! locus: per-file symbol tags (definitions, imports, references) for the
//! repository map and `edit_symbol`. See `pi_ast::tags`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

#[napi(object)]
pub struct TagsOptions {
	/// Source code to inspect.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
}

#[napi(object)]
pub struct SymbolTag {
	/// Bare declared name.
	pub name:       String,
	/// Dotted container path plus name (`UserStore.fetch`).
	pub qname:      String,
	/// `function`, `method`, `class`, `struct`, `interface`, `trait`, `type`,
	/// `enum`, `const`, `var`, `module`, `macro` or `property`.
	pub kind:       String,
	/// 1-indexed inclusive first line of the edit range (docs, decorators and
	/// attributes included).
	pub start_line: u32,
	/// 1-indexed inclusive last line of the edit range.
	pub end_line:   u32,
	/// Byte offset of the edit range start.
	pub start_byte: u32,
	/// Byte offset one past the edit range end.
	pub end_byte:   u32,
	/// 1-indexed line of the declared name.
	pub name_line:  u32,
	/// Visible outside its module.
	pub exported:   bool,
	/// Declaration head, whitespace collapsed, body omitted.
	pub signature:  String,
	/// Index of the container symbol in `symbols`.
	pub parent:     Option<u32>,
	/// Trait of a Rust `impl Trait for Type` member.
	pub detail:     Option<String>,
}

#[napi(object)]
pub struct ImportName {
	/// Exported name (`*` for namespace/glob, `default` for default imports).
	pub imported: String,
	/// Local binding.
	pub local:    String,
}

#[napi(object)]
pub struct ImportTag {
	/// Module specifier as written.
	pub specifier: String,
	/// `import`, `reexport`, `dynamic`, `use` or `mod`.
	pub kind:      String,
	/// Bound names.
	pub names:     Vec<ImportName>,
	/// Go import alias.
	pub alias:     Option<String>,
	/// 1-indexed line.
	pub line:      u32,
}

#[napi(object)]
pub struct RefTag {
	/// Referenced name (last path segment).
	pub name:      String,
	/// Leading path or receiver as written.
	pub qualifier: Option<String>,
	/// `call`, `new`, `macro` or `type`.
	pub kind:      String,
	/// Index of the innermost enclosing symbol in `symbols`.
	pub enclosing: Option<u32>,
	/// 1-indexed line of the first occurrence.
	pub line:      u32,
	/// Folded occurrence count.
	pub count:     u32,
}

#[napi(object)]
pub struct FileTags {
	/// Canonical language name.
	pub language:   Option<String>,
	/// Whether the language has a tags walker (TS/TSX/JS, Go, Rust).
	pub supported:  bool,
	/// Whether the tree contains ERROR or MISSING nodes.
	pub has_errors: bool,
	/// Total line count.
	pub line_count: u32,
	pub symbols:    Vec<SymbolTag>,
	pub imports:    Vec<ImportTag>,
	pub refs:       Vec<RefTag>,
}

impl From<pi_ast::tags::FileTags> for FileTags {
	fn from(v: pi_ast::tags::FileTags) -> Self {
		Self {
			language:   v.language,
			supported:  v.supported,
			has_errors: v.has_errors,
			line_count: v.line_count,
			symbols:    v
				.symbols
				.into_iter()
				.map(|s| SymbolTag {
					name:       s.name,
					qname:      s.qname,
					kind:       s.kind,
					start_line: s.start_line,
					end_line:   s.end_line,
					start_byte: s.start_byte,
					end_byte:   s.end_byte,
					name_line:  s.name_line,
					exported:   s.exported,
					signature:  s.signature,
					parent:     s.parent,
					detail:     s.detail,
				})
				.collect(),
			imports:    v
				.imports
				.into_iter()
				.map(|i| ImportTag {
					specifier: i.specifier,
					kind:      i.kind,
					names:     i
						.names
						.into_iter()
						.map(|n| ImportName { imported: n.imported, local: n.local })
						.collect(),
					alias:     i.alias,
					line:      i.line,
				})
				.collect(),
			refs:       v
				.refs
				.into_iter()
				.map(|r| RefTag {
					name:      r.name,
					qualifier: r.qualifier,
					kind:      r.kind,
					enclosing: r.enclosing,
					line:      r.line,
					count:     r.count,
				})
				.collect(),
		}
	}
}

fn extract(options: TagsOptions) -> Result<FileTags> {
	pi_ast::tags::extract_tags(pi_ast::tags::TagsOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}

/// Extract symbols, imports and references from one file on the calling
/// thread. Prefer [`extract_tags_async`] for bulk indexing.
#[napi]
pub fn extract_tags(options: TagsOptions) -> Result<FileTags> {
	extract(options)
}

/// Same as [`extract_tags`], on libuv's thread pool.
#[napi]
pub fn extract_tags_async(options: TagsOptions) -> task::Promise<FileTags> {
	task::blocking("extract_tags", (), move |_| extract(options))
}
