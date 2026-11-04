#!/usr/bin/env python3
"""Vendor LMDB into client/native/third_party, for build.rs to compile.

    update.py lmdb <checkout>    an LMDB git checkout at the release tag to vendor

Each vendored file gets a header naming its origin, version, and license, per the repo's
vendoring rules.  The library's entry in the root NOTICE is rewritten too.
"""

import os
import re
import subprocess
import sys

NATIVE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTICE = os.path.join(os.path.dirname(os.path.dirname(NATIVE)), "NOTICE")


def comment(lines):
    """lines as the body of a C block comment"""
    return "\n".join((" * " + line).rstrip() for line in lines)


def header(origin, spdx, license_text):
    return "/*!\n" + comment(origin + ["Unmodified.", "", "SPDX-License-Identifier: " + spdx, ""]
                           + license_text.strip().splitlines()) + "\n */\n"


def vendor(lib, files, src, origin_of, spdx, license_text):
    """copy each file from src into third_party/<lib>, headed"""
    out = os.path.join(NATIVE, "third_party", lib)
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


def lmdb(checkout):
    commit = subprocess.check_output(["git", "-C", checkout, "rev-parse", "HEAD"], text=True).strip()
    if subprocess.check_output(["git", "-C", checkout, "status", "--porcelain"], text=True).strip():
        sys.exit("the LMDB checkout has local changes")
    src = os.path.join(checkout, "libraries", "liblmdb")
    with open(os.path.join(src, "lmdb.h")) as f:
        h = f.read()
    version = ".".join(re.search(r"#define MDB_VERSION_%s\s+(\d+)" % part, h).group(1)
                       for part in ("MAJOR", "MINOR", "PATCH"))
    with open(os.path.join(src, "COPYRIGHT")) as f:
        copyright_text = f.read()
    with open(os.path.join(src, "LICENSE")) as f:
        license_text = f.read()

    # the library's sources and headers; the tools and tests stay behind
    files = ["mdb.c", "midl.c", "lmdb.h", "midl.h"]
    origin = lambda name: [
        "Vendored from LMDB by Howard Chu, Symas Corp.,",
        "https://github.com/LMDB/lmdb, file libraries/liblmdb/%s," % name,
        "at commit %s (version %s)." % (commit, version),
    ]
    vendor("lmdb", files, src, origin, "OLDAP-2.8",
           copyright_text.strip() + "\n\n" + license_text)

    notice("LMDB", "\n".join([
        "LMDB %s, commit %s" % (version, commit[:7]),
        "https://github.com/LMDB/lmdb",
        "",
        copyright_text.strip(),
        "",
        license_text.strip(),
        "",
        "Used for the store of the native client hosts, in these files:",
        "",
        "    - client/native/third_party/lmdb/",
    ]))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "lmdb":
        lmdb(sys.argv[2])
    else:
        sys.exit(__doc__)
