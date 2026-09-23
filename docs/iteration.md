# Iteration History

Completed project changes are recorded here in reverse chronological order.
Architecture describes the current system; this file preserves change history
and the sources that actually informed each solution.

## 2026-09-23 - Align Repository Policy

### Changes

- Aligned the repository rules with the active user-level policy, including
  research traceability, architecture maintenance, mathematical verification,
  Conventional Commits, and topic-branch naming.
- Added shared Git-policy validation for commit subjects and branch names,
  connected it to local hooks and pull-request CI, and synchronized the GitHub
  protected-branch commit pattern with the configured policy.
- Added machine checks for the architecture and iteration records and created
  an implementation-verified architecture guide with data-flow, lifecycle, and
  failure-path diagrams.
- Corrected the README to describe SQLite notebook storage and the legacy
  `data/techniques` import accurately.

### Research and Prior Art

- David Harel, [Statecharts: A Visual Formalism for Complex
  Systems](<https://doi.org/10.1016/0167-6423(87)90035-9>) (1987), informed the
  choice to document event-driven lifecycle behavior as explicit state
  diagrams rather than prose-only status lists.
- Simon Brown's [C4 model](https://c4model.com/) informed the progressive
  system-context and component-responsibility views in the architecture guide.
- The [Mermaid state diagram
  documentation](https://mermaid.js.org/syntax/stateDiagram.html) supplied the
  repository-native diagram notation used for maintainable workflow views.
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
  supplied the commit grammar enforced by local hooks and the branch ruleset.
- The Twelve-Factor App's [configuration
  guidance](https://12factor.net/config) supported retaining environment reads
  behind the existing typed runtime configuration boundary.

### Verification

- Added positive, negative, and maximum-length tests for commit subjects, plus
  protected, valid, and malformed branch-name cases.
- Added repository-policy tests for complete, missing, and incomplete required
  documentation and for GitHub/config commit-pattern drift.
- Ran the repository policy check, formatting, type checking, linting, unit
  tests, build, and credential-free browser tests.
