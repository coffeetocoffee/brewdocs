---
title: Lib
summary: A tiny library fixture for BrewDocs extractor tests.
---

# lib

A small library used to exercise the **JSDoc/TSDoc** and **exports** extractors.

## Usage

```ts
import { brew } from "lib";
brew("./repo", 3);
```

## Notes

This package intentionally documents its exports with JSDoc so Phase 1 can
pull params, return values, examples, and deprecation notices.
