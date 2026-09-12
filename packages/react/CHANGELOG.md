# Changelog

## 0.2.1

- JSON tree array entries now display zero-based indices (`[0]`, `[1]`, …), including nested arrays and object entries. Object keys remain quoted, including numeric and empty keys.
- Added component rendering regression tests for these cases.

Validation: workspace build, React package typecheck, 15 React package tests, and package dry-run passed. The existing `examples/react-web` app still references the old `@unipat/file-preview-react` package and its server contracts differ from the standalone React contracts; whole-workspace typecheck remains blocked by that legacy example. This patch does not change the server integration contract.
