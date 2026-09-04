# widget

A package that exports a class, an interface, and constants — used to confirm
the extractor handles multiple symbol kinds.

## Usage

```ts
import { Widget, SIZE_SM } from "widget";
const w = new Widget(SIZE_SM);
```

## Notes

No JSDoc here on purpose, to verify the extractor still produces symbols
without documentation comments.
