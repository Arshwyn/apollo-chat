# Test fixtures

- `fake-claude.mjs`: stand-in for the claude CLI.
- `heic-plain.heic`: 64x64 four-colour HEVC image (no metadata, no photo), taken unchanged from the libheif project's fuzzing corpus (`colors-no-alpha.heic`, LGPL-3.0 project).
- `heic-rotated.heic`: the same file with a 90 degree counter-clockwise rotation property (`irot`) added to its container by editing the box sizes by hand; the pixel data is untouched.
