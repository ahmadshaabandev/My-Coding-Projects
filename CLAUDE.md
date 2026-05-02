# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dev Server

Serve files locally with Python's built-in HTTP server:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080/<filename>.html` in a browser.

## Structure

This is a plain static HTML workspace — no build system, no package manager, no framework. Files are vanilla HTML/CSS/JS served directly from the filesystem.

Top-level `.html` files are standalone pages. Sub-projects live in their own subdirectories with an `index.html` entry point.
