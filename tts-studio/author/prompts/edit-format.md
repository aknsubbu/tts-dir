Answer with only what changes:

- `blocks`: each narration block you change or add, as `{ "id", "text", "after" }`. `text` is the block's whole new text, marks included, without its `[id]` line. For a new block, `after` is the id of the block it comes after; otherwise `""`.
- `remove_blocks`: the ids of blocks to delete.
- `classes`: each scene class you change or add, as `{ "name", "code", "after" }`. `code` is the whole class, from its `class` line to its last line, with any comment you want directly above it. For a new class, `after` is the class it comes after (`""` puts it at the end); otherwise `""`.
- `remove_classes`: the classes to delete.
- `preamble`: the code above the first class (imports, `COLORS`, helper functions), only when it must change; otherwise `""`.
- `whole_script` and `whole_scenes`: only when the change runs through nearly all of a file, that complete file instead; otherwise `""`.
- `summary`: one sentence saying what you changed.

Everything you leave out stays exactly as it is. Leave out narration you do not need to change: its audio is already recorded and is reused, and unchanged scenes are not rendered again. Each block must still be played by exactly one scene: a new block needs a `with self.voiceover("id")` in some class, and a removed one must no longer be played.
