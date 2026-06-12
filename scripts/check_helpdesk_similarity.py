#!/usr/bin/env python3
"""Behavior checks for Helpdesk similar-item suggestions."""

import ast
import re
import unicodedata
from pathlib import Path


APP_CONFIG = Path("applications/helpdesk/app-configmap.yaml")
APP_MARKER = "  app.py: |\n"


def load_similarity_code():
    text = APP_CONFIG.read_text(encoding="utf-8")
    _, app_block = text.split(APP_MARKER, 1)
    app_source = "".join(
        line[4:] if line.startswith("    ") else line
        for line in app_block.splitlines(keepends=True)
    )
    tree = ast.parse(app_source)
    selected = []
    required_functions = {"clean", "similarity_tokens", "similarity_score"}
    found_functions = set()
    found_stop_words = False
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in required_functions:
            node.decorator_list = []
            selected.append(node)
            found_functions.add(node.name)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name)
            and target.id == "SIMILARITY_STOP_WORDS"
            for target in node.targets
        ):
            selected.append(node)
            found_stop_words = True
    assert found_functions == required_functions
    assert found_stop_words
    module = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, "similarity-test.py", "exec")


def main():
    namespace = {"re": re, "unicodedata": unicodedata}
    exec(load_similarity_code(), namespace)
    tokens = namespace["similarity_tokens"]
    score = namespace["similarity_score"]

    source = tokens(
        "Brak poczty w Outlooku",
        "Nie działa wysyłanie wiadomości do klientów.",
    )
    similar_ticket = tokens(
        "Outlooku nie można używać",
        "Poczty nie da się wysłać, wiadomości pozostają w skrzynce.",
    )
    unrelated_ticket = tokens(
        "Drukarka zacina papier",
        "Wymagana wymiana rolki podajnika.",
    )

    assert "poczty" in source
    assert "wiadomosci" in source
    assert "dziala" not in source
    assert "nie" not in source

    similar_score, reasons = score(
        source,
        similar_ticket,
        same_category=True,
        same_subcategory=True,
    )
    assert similar_score >= 80
    assert any("Wspólne słowa" in reason for reason in reasons)
    assert "Ta sama kategoria" in reasons
    assert "Ta sama podkategoria" in reasons

    unrelated_score, unrelated_reasons = score(
        source,
        unrelated_ticket,
        same_category=True,
    )
    assert unrelated_score == 0
    assert unrelated_reasons == []

    capped_score, _ = score(
        {"one", "two", "three", "four"},
        {"one", "two", "three", "four"},
        same_category=True,
        same_subcategory=True,
    )
    assert capped_score == 100

    print("Helpdesk similarity checks passed")


if __name__ == "__main__":
    main()
