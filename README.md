# google-patents-details-mcp

An [MCP](https://modelcontextprotocol.io) server that fetches the **full Google Patents record for a single patent** through the [SerpApi Google Patents Details API](https://serpapi.com/google-patents-details-api). It returns compact Markdown that an LLM can read:

- bibliography: dates, assignees, inventors, family ID, PDF link
- abstract
- **all claims**, in full
- **full description text**, converted from HTML with paragraph numbers and section headings, and paged so long specifications fit into context
- CPC classifications
- worldwide family members with their legal status, plus priority, parent and child applications
- backward citations (including examiner-cited ones) and forward citations ("cited by"), with family-to-family variants
- legal events and the prosecution timeline
- optionally: similar documents and drawing image URLs

## Best used together with `google-patents`

This server **does not search**. It answers "give me everything about *this* patent".
For search, pair it with [**KunihiroS/google-patents-mcp**](https://github.com/KunihiroS/google-patents-mcp), whose `search_patents` tool queries Google Patents by keywords, dates, inventor, assignee and country. The two servers share the same SerpApi key and complement each other:

```
search_patents("solid-state battery separator", assignee="Toyota")   ← google-patents
        │  returns a list of publication numbers
        ▼
get_patent_details("JP2023123456A", sections=["claims"])            ← google-patents-details
        │  full claims, then the description, citations, family…
        ▼
get_patent_details("US10446823B2")    ← follow a "cited by" entry, and so on
```

The usual workflow: **search** to find candidates → **details** to read claims, check the family and legal status, and walk the citation graph.

## Tool: `get_patent_details`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `patent_id` | string | required | Publication number in any common form: `US10319978B2`, `US 10,319,978 B2`, `EP2549025A1`, `CN108963184B`, `patent/US10319978B2/en`, a `https://patents.google.com/patent/...` URL, or `scholar/<id>` |
| `language` | string | `en` | Google Patents page language (non-English patents come back machine-translated) |
| `sections` | string[] | see below | Any of `biblio`, `abstract`, `claims`, `description`, `classifications`, `family`, `citations`, `cited_by`, `legal_events`, `timeline`, `similar`, `images`. The default is everything except `similar` and `images` |
| `description_offset` | int | `0` | Character offset into the description, for paging |
| `description_max_chars` | int | `20000` | Maximum description characters returned per call |
| `max_list_items` | int | `30` | Maximum items per list section (citations, family, legal events and so on) |

Ask only for the sections you need. For example, `sections: ["claims"]` keeps the output small.

### Credits and caching

- Each **new** patent costs **1 SerpApi search credit**.
- Results are cached in memory for 1 hour. Paging through the description or asking for different sections of the same patent costs **no extra credit**.
- The description text is downloaded from SerpApi's `description_link`, which does not cost a credit.

### Example output (abridged)

```markdown
patent_id: patent/US10319978B2/en

# US10319978B2 — Multi-tabbed electrodes having high aspect ratios and batteries incorporating the same

## Bibliography
- **Application:** US15/604,759
- **Priority date:** 2017-05-25
- **Assignees:** GM Global Technology Operations LLC
- **Family ID:** 64109352
- **PDF:** https://patentimages.storage.googleapis.com/.../US10319978.pdf

## Claims (18)
1. A lithium battery cell, comprising: ...

## Family / worldwide applications (3)
- 2017-05-25 US US15/604,759 → US10319978B2 — Active (this)
- 2018-05-18 CN CN201810478074.4A → CN108963184B — Active
- 2018-05-21 DE DE102018112153.9A → DE102018112153B4 — Active

## Cited by (forward)
- US10446823B2 (2019-10-15) — Multi-tabbed electrodes having current-optimizing ... — GM Global Technology Operations LLC

## Description (chars 0–20000 of 34050)
## INTRODUCTION
[0001] Lithium ion batteries describe a class of rechargeable batteries ...
_[truncated: ... call again with description_offset=20000 for more — served from cache, no extra SerpApi credit]_
```

## Installation

You need Node.js 18 or newer and a [SerpApi](https://serpapi.com/) API key. The free plan includes 100 searches per month.

### 1. Provide the API key

The server reads `SERPAPI_API_KEY` from the environment. If the variable is not set, it falls back to the file `~/.google-patents-mcp.env` (`%USERPROFILE%\.google-patents-mcp.env` on Windows):

```dotenv
SERPAPI_API_KEY=your_serpapi_key
```

Keeping the key in this file keeps it out of your MCP client config. The `google-patents` search server uses the same file name, so you only need to set the key once (see the note below).

### 2. Register the server

**Claude Code** (any OS), straight from GitHub:

```bash
claude mcp add google-patents-details -s user -- npx -y github:kuchtgpt-svg/google-patents-details-mcp
```

On Windows, wrap `npx` in `cmd /c`:

```bash
claude mcp add google-patents-details -s user -- cmd /c npx -y github:kuchtgpt-svg/google-patents-details-mcp
```

Or from a local clone:

```bash
git clone https://github.com/kuchtgpt-svg/google-patents-details-mcp.git
cd google-patents-details-mcp && npm install
claude mcp add google-patents-details -s user -- node /absolute/path/to/google-patents-details-mcp/index.mjs
```

**Claude Desktop and other MCP hosts** (`claude_desktop_config.json` or similar):

```json
{
  "mcpServers": {
    "google-patents": {
      "command": "npx",
      "args": ["-y", "@kunihiros/google-patents-mcp"],
      "env": { "SERPAPI_API_KEY": "your_serpapi_key" }
    },
    "google-patents-details": {
      "command": "npx",
      "args": ["-y", "github:kuchtgpt-svg/google-patents-details-mcp"],
      "env": { "SERPAPI_API_KEY": "your_serpapi_key" }
    }
  }
}
```

You can leave out `env` for `google-patents-details` if you use the `~/.google-patents-mcp.env` file.

### Note on `google-patents` v0.2.0 and the `.env` file

The `google-patents-mcp` README says it reads `~/.google-patents-mcp.env`. Version 0.2.0 does **not** do this. Without `SERPAPI_API_KEY` in its environment it exits immediately, and your MCP client shows a "connection closed" error. Either pass the key through `env` in the host config, or launch it through a small wrapper that loads the file first. A Windows `.cmd` example:

```bat
@echo off
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%USERPROFILE%\.google-patents-mcp.env") do set "%%a=%%b"
npx -y @kunihiros/google-patents-mcp@0.2.0
```

```bash
claude mcp add google-patents -s user -- cmd /c C:\path\to\google-patents.cmd
```

`google-patents-details` reads the file itself and needs no wrapper.

## Disclaimer

This is an unofficial project and is not affiliated with Google or SerpApi. Patent data, including machine translations and legal status, comes from Google Patents through SerpApi and may be incomplete or out of date. Check official patent office records for anything that matters legally.

## License

[MIT](LICENSE)
