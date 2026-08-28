# Life-and-death problem sources

The shipped `default.jsonl` set contains positions curated for LingGo and is
validated by the server before it is exposed to players. The following
collections are useful candidates for future reviewed imports:

- [101weiqi](https://www.101weiqi.com/) has daily problems, problem sets,
  specialized training, search, and a life-and-death arena. Its site footer
  reserves all rights, so LingGo should link to it or obtain permission before
  copying problem data.
- [Fox Weiqi](https://www.foxwq.com/) publishes live events and game records.
  It is useful for finding positions from games, but no public problem-data
  license was found on the site; do not scrape or redistribute its records
  without permission.
- [baduk-study-material](https://github.com/benjaminmantle/baduk-study-material)
  organizes graded life-and-death SGF collections, including historical
  problem books. Its license notes that classical positions are public domain,
  while modern books, scans, and commentary may retain third-party rights.
- [GoGrinder](https://gogrinder.sourceforge.net/collections.php) documents
  public problem collections and SGF workflows, including graded tsumego and
  solution/refutation trees. Check each collection's provenance before import.

Before adding a source-derived set, record its provenance and license here,
convert only reviewed positions to the versioned JSONL format, and run the
loader's legality checks. Do not commit scraped site pages, login-required
content, copyrighted scans, or unverified solution trees.

The `gogameguru-easy.jsonl` set is a complete 140-problem, easy-level import from
the upstream [GoGameGuru problem repository](https://github.com/gogameguru/go-problems).
It includes setup stones and the canonical solution branch for each problem;
commentary and alternate refutation branches were intentionally omitted. The
upstream README identifies the source as `CC BY-NC-SA 4.0`, so this import is
suitable for non-commercial use with attribution and share-alike obligations.

The `gogameguru-intermediate.jsonl` and `gogameguru-hard.jsonl` sets carry all
140 positions from each corresponding upstream tier. Their source solution
trees are substantially deeper; the canonical branches are available to the
human practice flow while alternate variations remain available in the
upstream SGFs.

The `gogameguru-other.jsonl` set includes the compatible 19x19 eternal-life
position. The other upstream SGF, `heart-go-problem.sgf`, is 13x13 and is not
imported because LingGo requires 19x19 problem boards.
