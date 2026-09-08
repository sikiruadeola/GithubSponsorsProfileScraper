# GitHub Sponsors Profile Scraper

Walks every public GitHub Sponsors profile using GitHub's own official
GraphQL API and saves each one's login, profile link, bio, and any personal
links, website, or public email found.

## How it works

Uses GitHub's `sponsorables` GraphQL query, which lists every user and
organization who has a public GitHub Sponsors page open. No scraping
involved, this is intentionally exposed by GitHub itself.

The list is walked forward page by page. Progress (the pagination cursor)
is saved after every single page, so a run that stops partway through never
repeats work, and the next run picks up exactly where the last one left off.

## What it saves

- `username`
- `profileLink`
- `bio` — for organizations, this is their description field
- `links` — website, X/Twitter, and public email if present

## Input

| Field | Description | Default |
|---|---|---|
| `githubToken` | Personal access token, optional if one is embedded in the source | — |
| `pageSize` | Profiles requested per page, max 100 | `50` |
| `maxNewProfiles` | Stop after saving this many, `0` for unlimited | `0` |
| `maxPages` | Stop after this many pages, `0` for unlimited | `0` |

## Notes

A token with no scopes ticked at all works fine, since this only ever reads
data that is already public.
