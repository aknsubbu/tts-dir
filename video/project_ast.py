"""What build.py needs to know about a scenes.py without running it. Standard library only.

    scene_classes(tree)            {name: ClassDef} for classes with VoiceoverScene in their bases
    blocks_played(cls)             narration block ids a scene plays, as written in self.voiceover("...")
    class_span(cls)                (first, last) line of a class, decorators and comments above it included
    scene_fingerprint(source, ...) the parts of the file that decide what one scene draws
"""
import ast
import hashlib


def _base_names(cls):
    return [b.id if isinstance(b, ast.Name) else getattr(b, "attr", "") for b in cls.bases]


def scene_classes(tree):
    return {n.name: n for n in tree.body if isinstance(n, ast.ClassDef) and "VoiceoverScene" in _base_names(n)}


def blocks_played(cls):
    out = []
    for node in ast.walk(cls):
        if isinstance(node, ast.With):
            for item in node.items:
                call = item.context_expr
                if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == "voiceover"
                        and call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str)):
                    out.append(call.args[0].value)
    return out


def class_span(cls, lines):
    """1-based inclusive line range of a class, with its decorators and the comment lines directly above it."""
    first = min([cls.lineno] + [d.lineno for d in cls.decorator_list])
    while first > 1 and lines[first - 2].lstrip().startswith("#"):
        first -= 1
    return first, cls.end_lineno


def module_code(source, tree, classes):
    """The file without the given classes: imports, constants, helper functions and helper classes."""
    lines = source.splitlines()
    drop = set()
    for cls in classes:
        a, b = class_span(cls, lines)
        drop.update(range(a, b + 1))
    return "\n".join(line for n, line in enumerate(lines, 1) if n not in drop)


def _segment(source, cls):
    lines = source.splitlines()
    a, b = class_span(cls, lines)
    return "\n".join(lines[a - 1:b])


def scene_fingerprint(source, tree, name):
    """sha256 of what decides scene `name`'s picture: the module's shared code, the class itself,
    and any scene class in the file it inherits from. Other scenes do not count."""
    scenes = scene_classes(tree)
    parts = [module_code(source, tree, scenes.values())]
    seen, todo = set(), [name]
    while todo:
        cur = todo.pop()
        if cur in seen or cur not in scenes:
            continue
        seen.add(cur)
        parts.append(_segment(source, scenes[cur]))
        todo.extend(_base_names(scenes[cur]))
    return hashlib.sha256("\n\x00\n".join(parts).encode("utf-8")).hexdigest()
