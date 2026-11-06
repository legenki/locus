use super::*;

fn tags(code: &str, path: &str) -> FileTags {
	extract_tags(TagsOptions { code: code.to_owned(), lang: None, path: Some(path.to_owned()) })
		.unwrap()
}

fn sym<'a>(t: &'a FileTags, qname: &str) -> &'a SymbolTag {
	let found: Vec<&SymbolTag> = t.symbols.iter().filter(|s| s.qname == qname).collect();
	assert_eq!(
		found.len(),
		1,
		"expected one `{qname}`, got {:?}",
		t.symbols.iter().map(|s| &s.qname).collect::<Vec<_>>()
	);
	found[0]
}

fn qnames(t: &FileTags) -> Vec<&str> {
	t.symbols.iter().map(|s| s.qname.as_str()).collect()
}

// The edit range of an exported, decorated, documented class member covers
// its JSDoc and decorators, so `edit_symbol replace` never orphans them.
#[test]
fn ts_class_members_ranges_include_docs_and_decorators() {
	let code = "\
import { Injectable } from \"@core/di\";

// unrelated note
/** Store of users. */
@Injectable()
export class UserStore {
  /** Load one. */
  @Cached()
  async fetch(id: Id): Promise<User> {
    return this.http.get(id);
  }

  private cache = new Map<Id, User>();
}
";
	let t = tags(code, "src/store.ts");
	assert!(t.supported && !t.has_errors);
	let class = sym(&t, "UserStore");
	assert_eq!((class.kind.as_str(), class.exported), ("class", true));
	// Starts at the JSDoc (line 4), not at the plain `//` note on line 3.
	assert_eq!((class.start_line, class.end_line), (4, 14));
	let fetch = sym(&t, "UserStore.fetch");
	assert_eq!(fetch.kind, "method");
	assert_eq!((fetch.start_line, fetch.end_line, fetch.name_line), (7, 11, 9));
	assert_eq!(fetch.signature, "async fetch(id: Id): Promise<User>");
	assert_eq!(
		fetch.parent,
		Some(
			t.symbols
				.iter()
				.position(|s| s.qname == "UserStore")
				.unwrap() as u32
		)
	);
	assert_eq!(sym(&t, "UserStore.cache").kind, "property");
	assert_eq!(&code[class.start_byte as usize..class.start_byte as usize + 3], "/**");
}

// Overloads stay separate candidates; `edit_symbol` must see the ambiguity.
#[test]
fn ts_overloads_are_distinct_symbols() {
	let code = "\
export function parse(a: string): Ast;
export function parse(a: Buffer): Ast;
export function parse(a: string | Buffer): Ast { return impl(a); }
";
	let t = tags(code, "parse.ts");
	let parses: Vec<_> = t.symbols.iter().filter(|s| s.qname == "parse").collect();
	assert_eq!(parses.len(), 3);
	assert_eq!(parses.iter().map(|s| s.start_line).collect::<Vec<_>>(), vec![1, 2, 3]);
}

// Imports carry binding names; re-exports and dynamic imports are distinct
// kinds the resolver treats differently.
#[test]
fn ts_imports_reexports_and_dynamic() {
	let code = "\
import def, { a, b as c } from './x';
import * as ns from \"../y\";
import './side-effect';
export { z as w } from './z';
export * from './all';
const lazy = () => import('./lazy');
const legacy = require('legacy');
";
	let t = tags(code, "m.ts");
	let by_spec = |s: &str| t.imports.iter().find(|i| i.specifier == s).unwrap();
	let x = by_spec("./x");
	assert_eq!(x.kind, "import");
	assert_eq!(x.names, vec![
		ImportName { imported: "default".into(), local: "def".into() },
		ImportName { imported: "a".into(), local: "a".into() },
		ImportName { imported: "b".into(), local: "c".into() },
	]);
	assert_eq!(by_spec("../y").names, vec![ImportName {
		imported: "*".into(),
		local:    "ns".into(),
	}]);
	assert!(by_spec("./side-effect").names.is_empty());
	let z = by_spec("./z");
	assert_eq!(
		(z.kind.as_str(), z.names[0].imported.as_str(), z.names[0].local.as_str()),
		("reexport", "z", "w")
	);
	assert_eq!(by_spec("./all").names[0].imported, "*");
	assert_eq!(by_spec("./lazy").kind, "dynamic");
	assert_eq!(by_spec("legacy").kind, "dynamic");
}

// Calls attach to the innermost enclosing symbol and fold repeats; locals
// inside bodies are not symbols; declaration names are not refs.
#[test]
fn ts_refs_attach_to_enclosing_symbol() {
	let code = "\
export const handler = (req: Request) => {
  function local() { return 1; }
  validate(req); validate(req);
  return new Response(api.send(req));
};
";
	let t = tags(code, "h.ts");
	assert_eq!(qnames(&t), vec!["handler"]);
	assert_eq!(t.symbols[0].kind, "function");
	let handler = Some(0);
	let r = |name: &str| {
		t.refs
			.iter()
			.find(|r| r.name == name)
			.unwrap_or_else(|| panic!("no ref {name}"))
	};
	assert_eq!((r("validate").count, r("validate").enclosing), (2, handler));
	assert_eq!(r("Response").kind, "new");
	assert_eq!(r("send").qualifier.as_deref(), Some("api"));
	assert_eq!(r("Request").kind, "type");
	assert!(t.refs.iter().all(|r| r.name != "handler"));
}

// Go methods are qualified by receiver type whatever the pointer/generic form,
// and export follows capitalization.
#[test]
fn go_methods_imports_and_exports() {
	let code = "\
package store

import (
	\"context\"
	db \"example.com/app/internal/db\"
)

// Store keeps users.
type Store struct{ conn *db.Conn }

type reader interface {
	Read(ctx context.Context) error
}

func (s *Store) Get(ctx context.Context, id int) (*User, error) {
	return db.Query(ctx, id)
}

func (l List[T]) len() int { return 0 }

func New() *Store { return &Store{} }

const (
	MaxUsers = 10
	minUsers = 1
)
";
	let t = tags(code, "store/store.go");
	assert!(!t.has_errors);
	let store = sym(&t, "Store");
	// The `//` doc comment directly above is part of the range.
	assert_eq!(
		(store.kind.as_str(), store.start_line, store.name_line, store.exported),
		("struct", 8, 9, true)
	);
	let get = sym(&t, "Store.Get");
	assert_eq!(get.kind, "method");
	assert_eq!(get.parent, Some(t.symbols.iter().position(|s| s.qname == "Store").unwrap() as u32));
	assert_eq!(get.signature, "func (s *Store) Get(ctx context.Context, id int) (*User, error)");
	assert!(!sym(&t, "List.len").exported);
	assert_eq!(sym(&t, "reader.Read").kind, "method");
	assert!(sym(&t, "MaxUsers").exported && !sym(&t, "minUsers").exported);
	let db = t
		.imports
		.iter()
		.find(|i| i.specifier == "example.com/app/internal/db")
		.unwrap();
	assert_eq!(db.alias.as_deref(), Some("db"));
	let q = t.refs.iter().find(|r| r.name == "Query").unwrap();
	assert_eq!(
		(q.qualifier.as_deref(), q.enclosing),
		(
			Some("db"),
			Some(
				t.symbols
					.iter()
					.position(|s| s.qname == "Store.Get")
					.unwrap() as u32
			)
		)
	);
}

// Rust: methods from inherent and trait impls share `Type.method` (so the
// caller sees them as candidates), trait impls carry the trait in `detail`,
// attributes and `///` docs are part of the range.
#[test]
fn rust_impls_uses_and_mods() {
	let code = "\
use std::fmt;
use crate::graph::{self, Edge as E, rank::*};

mod parser;

/// A file node.
#[derive(Debug)]
pub struct Node { id: u32 }

impl Node {
    pub fn id(&self) -> u32 { self.id }
    fn fmt(&self) -> String { format!(\"{}\", self.id) }
}

impl fmt::Display for Node {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = graph::label(self.id);
        write!(f, \"{label}\")
    }
}

pub trait Rank {
    fn rank(&self) -> f64;
}
";
	let t = tags(code, "src/node.rs");
	assert!(!t.has_errors);
	let node = sym(&t, "Node");
	assert_eq!(
		(node.kind.as_str(), node.exported, node.start_line, node.end_line),
		("struct", true, 6, 8)
	);
	let fmts: Vec<_> = t.symbols.iter().filter(|s| s.qname == "Node.fmt").collect();
	assert_eq!(fmts.len(), 2);
	assert_eq!(fmts[0].detail, None);
	assert_eq!(fmts[1].detail.as_deref(), Some("Display"));
	assert!(fmts.iter().all(|s| s.kind == "method"));
	assert!(sym(&t, "Node.id").exported);
	assert_eq!(sym(&t, "Rank.rank").kind, "method");

	let uses: Vec<(&str, &str, &str)> = t
		.imports
		.iter()
		.flat_map(|i| {
			i.names
				.iter()
				.map(move |n| (i.specifier.as_str(), n.imported.as_str(), n.local.as_str()))
		})
		.collect();
	assert_eq!(uses, vec![
		("std", "fmt", "fmt"),
		("crate", "graph", "graph"),
		("crate::graph", "Edge", "E"),
		("crate::graph::rank", "*", "*"),
	]);
	assert!(
		t.imports
			.iter()
			.any(|i| i.kind == "mod" && i.specifier == "parser")
	);
	let label = t.refs.iter().find(|r| r.name == "label").unwrap();
	assert_eq!(label.qualifier.as_deref(), Some("graph"));
	assert!(
		t.refs
			.iter()
			.any(|r| r.name == "write" && r.kind == "macro")
	);
}

// Multi-line heads collapse to one tidy line; `export` is implied, never shown.
#[test]
fn signatures_are_single_line_and_tidy() {
	let code = "\
export function record(
  store: Store,
  path: string,
): void {
  return;
}
export const LIMIT = 10;
";
	let t = tags(code, "s.ts");
	assert_eq!(sym(&t, "record").signature, "function record(store: Store, path: string): void");
	assert_eq!(sym(&t, "LIMIT").signature, "const LIMIT = 10");
}

#[test]
fn unsupported_and_unknown_languages() {
	let py = tags("def f():\n  pass\n", "a.py");
	assert_eq!((py.language.as_deref(), py.supported, py.line_count), (Some("python"), false, 2));
	assert!(py.symbols.is_empty());
	let unknown = tags("hello", "a.unknownext");
	assert_eq!((unknown.language, unknown.supported, unknown.line_count), (None, false, 1));
}

#[test]
fn syntax_errors_are_reported() {
	let t = tags("export function broken( {\n", "b.ts");
	assert!(t.has_errors);
}
