# Third-party notices

## Lucide

The icon geometry in `lib/icons.js` is vendored from **Lucide**
(<https://lucide.dev>), release **v1.47.0** (`lucide-static`).

- **Licence:** ISC
- **Vendored?** Yes — the path data is copied into the repository as string
  literals, so that this zero-dependency, build-free static page never contacts a
  CDN at runtime and never depends on React.
- **Modifications:** none to the geometry itself. `pathDataOf()` converts each
  element to raw SVG path data at draw time (extracting `<path>` `d` attributes
  verbatim, and expanding each `<circle cx cy r>` into two half-arcs), because
  `Path2D` parses path data and not XML elements.

Full ISC licence text:

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Everything else

The rest of the project is original work, MIT-licensed — see `LICENSE`. There are
**no runtime dependencies**: Node's standard library only.