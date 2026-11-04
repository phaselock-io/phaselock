#!/usr/bin/env python3
"""Vendor QuickJS into core/third_party, for build.rs to compile.

    update.py quickjs <checkout>    a QuickJS git checkout at the commit to vendor

Each vendored file gets a header naming its origin, version, and license, per the repo's
vendoring rules; build.rs reads the version from quickjs.c's header.  The library's entry in the
root NOTICE is rewritten too.
"""

import os
import subprocess
import sys

CORE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTICE = os.path.join(os.path.dirname(CORE), "NOTICE")


def comment(lines):
    """lines as the body of a C block comment"""
    return "\n".join((" * " + line).rstrip() for line in lines)


def header(origin, spdx, license_text):
    return "/*!\n" + comment(origin + ["Unmodified.", "", "SPDX-License-Identifier: " + spdx, ""]
                           + license_text.strip().splitlines()) + "\n */\n"


def vendor(lib, files, src, origin_of, spdx, license_text):
    """copy each file from src into third_party/<lib>, headed"""
    out = os.path.join(CORE, "third_party", lib)
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        os.remove(os.path.join(out, name))
    for name in files:
        with open(os.path.join(src, name), encoding="utf-8", errors="surrogateescape") as f:
            body = f.read()
        with open(os.path.join(out, name), "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write(header(origin_of(name), spdx, license_text) + body)


def notice(title, entry):
    """rewrite the NOTICE entry whose first line starts with title, or append one"""
    with open(NOTICE) as f:
        text = f.read().rstrip("\n")
    chunks = text.split("\n\n\n")
    for i, chunk in enumerate(chunks):
        if chunk.startswith(title + " "):
            chunks[i] = entry
            break
    else:
        chunks.append(entry)
    with open(NOTICE, "w") as f:
        f.write("\n\n\n".join(chunks) + "\n")


def quickjs(checkout):
    commit = subprocess.check_output(["git", "-C", checkout, "rev-parse", "HEAD"], text=True).strip()
    if subprocess.check_output(["git", "-C", checkout, "status", "--porcelain"], text=True).strip():
        sys.exit("the QuickJS checkout has local changes")
    with open(os.path.join(checkout, "VERSION")) as f:
        version = f.read().strip()
    with open(os.path.join(checkout, "LICENSE")) as f:
        license_text = f.read()

    # the library's sources, and every header they include
    sources = ["quickjs.c", "libregexp.c", "libunicode.c", "cutils.c", "dtoa.c"]
    headers = ["quickjs.h", "quickjs-atom.h", "quickjs-opcode.h", "libregexp.h",
               "libregexp-opcode.h", "libunicode.h", "libunicode-table.h", "cutils.h", "dtoa.h",
               "list.h"]
    origin = lambda name: [
        "Vendored from QuickJS by Fabrice Bellard and Charlie Gordon,",
        "https://github.com/bellard/quickjs, file %s," % name,
        "at commit %s (version %s)." % (commit, version),
    ]
    vendor("quickjs", sources + headers, checkout, origin, "MIT", license_text)

    notice("QuickJS", "\n".join([
        "QuickJS %s, commit %s" % (version, commit[:7]),
        "https://github.com/bellard/quickjs",
        "",
        license_text.strip(),
        "",
        "Used for the JavaScript runtime of the Rust hosts, in these files:",
        "",
        "    - core/third_party/quickjs/",
    ]))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "quickjs":
        quickjs(sys.argv[2])
    else:
        sys.exit(__doc__)
