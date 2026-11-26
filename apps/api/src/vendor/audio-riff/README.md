# Official Kaitai RIFF parser

`Riff.cjs` is an unchanged copy of the official generated `Riff.js`, renamed
only so Node/Bun loads its published UMD/CommonJS form in this ESM package.

- Source: https://formats.kaitai.io/riff/src/javascript/Riff.js
- SHA-256: `c4ebe7180d834cbb0b4efe5f58022518901b8852bcb07ace2a3e660abc724d01`
- Source license: CC0-1.0, stated at https://formats.kaitai.io/riff/javascript.html
- Fixed schema: https://github.com/kaitai-io/kaitai_struct_formats/blob/e510abe1e596097458586f57425f08c4d59c8b32/common/riff.ksy
- `riff.ksy` SHA-256: `8e43fd273dad55ef3d654a47645477b80048b81b78648eedb8044ba7ff1cad72`
- Runtime: `kaitai-struct@0.11.0`, Apache-2.0, source commit
  `b2bddfd259e6a3678b82c60cb6e84d84481a2112`.

The exact compiler version used by the official gallery was not independently
rebuilt. These are fixed downloaded source bytes and schema provenance, not a
claim of reproducible generation. Preserve the generated file unchanged; make
future schema/compiler updates as a separately reviewed change.

The caller uses generated `ChunkType` instances one at a time and explicit
bounded-stream traversal for LIST children. It does not access eager subchunk
arrays, decode INFO strings or inflate application-specific metadata. This is
container-boundary validation; actual PCM decoding remains the FFmpeg stage.
