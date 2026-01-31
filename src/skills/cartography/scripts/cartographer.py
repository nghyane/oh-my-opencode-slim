#!/usr/bin/env python3
"""
Cartographer - Repository mapping and change detection.

Commands:
  init     Initialize mapping (create hashes + empty codemaps)
  changes  Show what changed (read-only, like git status)
  update   Update hashes (like git commit)

Usage:
  cartographer.py init --root /path/to/repo --include "src/**/*.ts" --exclude "node_modules/**"
  cartographer.py changes --root /path/to/repo
  cartographer.py update --root /path/to/repo
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set

VERSION = "1.0.0"
STATE_DIR = ".slim"
STATE_FILE = "cartography.json"
CODEMAP_FILE = "codemap.md"


def load_gitignore(root: Path) -> List[str]:
    """Load .gitignore patterns."""
    gitignore_path = root / ".gitignore"
    patterns = []
    if gitignore_path.exists():
        with open(gitignore_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    patterns.append(line)
    return patterns


class PatternMatcher:
    """Match paths against glob patterns using compiled regex."""

    def __init__(self, patterns: List[str]):
        if not patterns:
            self.regex = None
            return

        regex_parts = []
        for pattern in patterns:
            reg = re.escape(pattern)
            reg = reg.replace(r'\*\*/', '(?:.*/)?')
            reg = reg.replace(r'\*\*', '.*')
            reg = reg.replace(r'\*', '[^/]*')
            reg = reg.replace(r'\?', '.')

            if pattern.endswith('/'):
                reg += '.*'

            if pattern.startswith('/'):
                reg = '^' + reg[1:]
            else:
                reg = '(?:^|.*/)' + reg
            
            regex_parts.append(f'(?:{reg}$)')
        
        self.regex = re.compile('|'.join(regex_parts))

    def matches(self, path: str) -> bool:
        if not self.regex:
            return False
        return bool(self.regex.search(path))


def select_files(
    root: Path,
    include_patterns: List[str],
    exclude_patterns: List[str],
    exceptions: List[str],
    gitignore_patterns: List[str],
) -> List[Path]:
    """Select files based on patterns."""
    selected = []
    
    include_matcher = PatternMatcher(include_patterns)
    exclude_matcher = PatternMatcher(exclude_patterns)
    gitignore_matcher = PatternMatcher(gitignore_patterns)
    exception_set = set(exceptions)
    
    root_str = str(root)
    
    for dirpath, dirnames, filenames in os.walk(root_str):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        
        rel_dir = os.path.relpath(dirpath, root_str)
        if rel_dir == ".":
            rel_dir = ""
        
        for filename in filenames:
            rel_path = os.path.join(rel_dir, filename).replace("\\", "/")
            if rel_path.startswith("./"):
                rel_path = rel_path[2:]
            
            if gitignore_matcher.matches(rel_path):
                continue
            
            if exclude_matcher.matches(rel_path):
                if rel_path not in exception_set:
                    continue
            
            if include_matcher.matches(rel_path) or rel_path in exception_set:
                selected.append(root / rel_path)
    
    return sorted(selected)


def compute_file_hash(filepath: Path) -> str:
    """Compute MD5 hash of file content."""
    hasher = hashlib.md5()
    try:
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except (IOError, OSError):
        return ""


def compute_folder_hash(folder: str, file_hashes: Dict[str, str]) -> str:
    """Compute hash for a folder based on its files."""
    folder_files = sorted(
        (path, hash_val)
        for path, hash_val in file_hashes.items()
        if path.startswith(folder + "/") or (folder == "." and "/" not in path)
    )
    
    if not folder_files:
        return ""
    
    hasher = hashlib.md5()
    for path, hash_val in folder_files:
        hasher.update(f"{path}:{hash_val}\n".encode())
    return hasher.hexdigest()


def get_folders_with_files(files: List[Path], root: Path) -> Set[str]:
    """Get all folders containing selected files."""
    folders = set()
    for f in files:
        rel = f.relative_to(root)
        parts = rel.parts[:-1]
        for i in range(len(parts)):
            folders.add("/".join(parts[: i + 1]))
    folders.add(".")
    return folders


def load_state(root: Path) -> Optional[dict]:
    """Load cartography state."""
    state_path = root / STATE_DIR / STATE_FILE
    if state_path.exists():
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None
    return None


def save_state(root: Path, state: dict) -> None:
    """Save cartography state."""
    state_dir = root / STATE_DIR
    state_dir.mkdir(parents=True, exist_ok=True)
    
    state_path = state_dir / STATE_FILE
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def create_empty_codemap(folder_path: Path, folder_name: str) -> None:
    """Create empty codemap.md with template."""
    codemap_path = folder_path / CODEMAP_FILE
    if not codemap_path.exists():
        content = f"""# {folder_name}/

## Responsibility
<!-- What this folder does -->

## Design
<!-- Key patterns, abstractions -->

## Flow
<!-- Data/control flow -->

## Integration
<!-- Dependencies and consumers -->
"""
        with open(codemap_path, "w", encoding="utf-8") as f:
            f.write(content)


def cmd_init(args: argparse.Namespace) -> int:
    """Initialize: create hashes and empty codemaps."""
    root = Path(args.root).resolve()
    
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        return 1
    
    gitignore = load_gitignore(root)
    include_patterns = args.include or ["**/*"]
    exclude_patterns = args.exclude or []
    exceptions = args.exception or []
    
    print(f"Scanning {root}...")
    selected_files = select_files(
        root, include_patterns, exclude_patterns, exceptions, gitignore
    )
    print(f"Selected {len(selected_files)} files")
    
    file_hashes: Dict[str, str] = {}
    for f in selected_files:
        rel_path = str(f.relative_to(root))
        file_hashes[rel_path] = compute_file_hash(f)
    
    folders = get_folders_with_files(selected_files, root)
    folder_hashes: Dict[str, str] = {}
    for folder in folders:
        folder_hashes[folder] = compute_folder_hash(folder, file_hashes)
    
    state = {
        "metadata": {
            "version": VERSION,
            "last_run": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "root": str(root),
            "include_patterns": include_patterns,
            "exclude_patterns": exclude_patterns,
            "exceptions": exceptions,
        },
        "file_hashes": file_hashes,
        "folder_hashes": folder_hashes,
    }
    
    save_state(root, state)
    print(f"Created {STATE_DIR}/{STATE_FILE}")
    
    for folder in folders:
        if folder == ".":
            folder_path = root
            folder_name = root.name
        else:
            folder_path = root / folder
            folder_name = folder
        create_empty_codemap(folder_path, folder_name)
    
    print(f"Created {len(folders)} empty codemap.md files")
    return 0


def cmd_changes(args: argparse.Namespace) -> int:
    """Show what changed."""
    root = Path(args.root).resolve()
    
    state = load_state(root)
    if not state:
        print("No state found. Run 'init' first.", file=sys.stderr)
        return 1
    
    metadata = state.get("metadata", {})
    include_patterns = metadata.get("include_patterns", ["**/*"])
    exclude_patterns = metadata.get("exclude_patterns", [])
    exceptions = metadata.get("exceptions", [])
    
    gitignore = load_gitignore(root)
    current_files = select_files(
        root, include_patterns, exclude_patterns, exceptions, gitignore
    )
    
    current_hashes: Dict[str, str] = {}
    for f in current_files:
        rel_path = str(f.relative_to(root))
        current_hashes[rel_path] = compute_file_hash(f)
    
    saved_hashes = state.get("file_hashes", {})
    
    added = set(current_hashes.keys()) - set(saved_hashes.keys())
    removed = set(saved_hashes.keys()) - set(current_hashes.keys())
    modified = {
        path for path in current_hashes.keys() & saved_hashes.keys()
        if current_hashes[path] != saved_hashes[path]
    }
    
    if not added and not removed and not modified:
        print("No changes.")
        return 0
    
    if added:
        print(f"\nAdded ({len(added)}):")
        for path in sorted(added):
            print(f"  + {path}")
    
    if removed:
        print(f"\nRemoved ({len(removed)}):")
        for path in sorted(removed):
            print(f"  - {path}")
    
    if modified:
        print(f"\nModified ({len(modified)}):")
        for path in sorted(modified):
            print(f"  ~ {path}")
    
    affected = set()
    for path in added | removed | modified:
        parts = Path(path).parts[:-1]
        for i in range(len(parts)):
            affected.add("/".join(parts[: i + 1]))
        affected.add(".")
    
    print(f"\nAffected folders ({len(affected)}):")
    for folder in sorted(affected):
        print(f"  {folder}/")
    
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    """Update hashes."""
    root = Path(args.root).resolve()
    
    state = load_state(root)
    if not state:
        print("No state found. Run 'init' first.", file=sys.stderr)
        return 1
    
    metadata = state.get("metadata", {})
    include_patterns = metadata.get("include_patterns", ["**/*"])
    exclude_patterns = metadata.get("exclude_patterns", [])
    exceptions = metadata.get("exceptions", [])
    
    gitignore = load_gitignore(root)
    selected_files = select_files(
        root, include_patterns, exclude_patterns, exceptions, gitignore
    )
    
    file_hashes: Dict[str, str] = {}
    for f in selected_files:
        rel_path = str(f.relative_to(root))
        file_hashes[rel_path] = compute_file_hash(f)
    
    folders = get_folders_with_files(selected_files, root)
    folder_hashes: Dict[str, str] = {}
    for folder in folders:
        folder_hashes[folder] = compute_folder_hash(folder, file_hashes)
    
    state["metadata"]["last_run"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    state["file_hashes"] = file_hashes
    state["folder_hashes"] = folder_hashes
    
    save_state(root, state)
    print(f"Updated {STATE_DIR}/{STATE_FILE} ({len(file_hashes)} files)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Cartographer - Repository mapping"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    init = subparsers.add_parser("init", help="Initialize mapping")
    init.add_argument("--root", required=True, help="Repository root")
    init.add_argument("--include", action="append", help="Include patterns")
    init.add_argument("--exclude", action="append", help="Exclude patterns")
    init.add_argument("--exception", action="append", help="Exceptions")
    
    changes = subparsers.add_parser("changes", help="Show changes")
    changes.add_argument("--root", required=True, help="Repository root")
    
    update = subparsers.add_parser("update", help="Update hashes")
    update.add_argument("--root", required=True, help="Repository root")
    
    args = parser.parse_args()
    
    if args.command == "init":
        return cmd_init(args)
    elif args.command == "changes":
        return cmd_changes(args)
    elif args.command == "update":
        return cmd_update(args)
    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
