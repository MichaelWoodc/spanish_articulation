import os

# CONFIG: set your base URL
BASE_URL = "https://michaelwoodc.github.io/spanish_articulation/"
ROOT_DIR = "."   # repo root

def find_html_files(root):
    html_files = []
    for dirpath, _, filenames in os.walk(root):
        for f in filenames:
            if f.endswith(".html"):
                rel_path = os.path.relpath(os.path.join(dirpath, f), root)
                html_files.append(rel_path.replace("\\", "/"))  # normalize for Windows
    return html_files

def build_tree(files):
    tree = {}
    for f in files:
        parts = f.split("/")
        node = tree
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node.setdefault("_files", []).append(parts[-1])
    return tree

def render_tree(tree, prefix=""):
    html = "<ul>\n"
    for key, val in sorted(tree.items()):
        if key == "_files":
            for fname in sorted(val):
                url = BASE_URL + prefix + fname
                html += f'  <li><a href="{url}">{prefix}{fname}</a></li>\n'
        else:
            # only render folder if it has html files inside
            if "_files" in val or any("_files" in v for v in val.values()):
                html += f"  <li>{key}\n"
                html += render_tree(val, prefix + key + "/")
                html += "  </li>\n"
    html += "</ul>\n"
    return html

files = find_html_files(ROOT_DIR)
tree = build_tree(files)
directory_html = "<!DOCTYPE html>\n<html><head><meta charset='utf-8'><title>Directory</title></head><body>\n"
directory_html += "<h1>HTML File Index</h1>\n"
directory_html += render_tree(tree)
directory_html += "</body></html>"

# Write to file
with open("directory.html", "w", encoding="utf-8") as f:
    f.write(directory_html)

print("✅ directory.html generated")
