# Project Instructions

## Testing

Do not run Playwright tests or `npm test` unless the user explicitly asks for
them. Use `npm run build` for the normal verification check.

## Search tools

`ast-grep` (`sg`) is installed — prefer it over grep/rg for structural/AST-aware
code searches (e.g. finding all calls to a function, matching syntax patterns
across languages, safe structural rewrites). Use plain grep for simple text/log
searches.
