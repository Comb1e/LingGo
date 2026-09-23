## Behavior

Describe the user-visible or internal behavior change and link the issue.

## Research and Prior Art

List the papers and projects actually used to establish the solution. Write `Not applicable` only when the change did not establish or revise a technical solution.

## Architecture and Iteration

- [ ] I updated `docs/architecture.md` for relevant system behavior, responsibilities, data flow, decisions, constraints, and failure paths, or no architecture changed.
- [ ] I added the change and its verification to `docs/iteration.md`.

## Engineering Policy

- [ ] I modeled every changed persistent complex workflow with an explicit state machine, or no such workflow changed.
- [ ] I placed shared and operational constants in the typed configuration modules, or no qualifying constant changed.
- [ ] I reused or introduced generic interfaces for behavior needed at multiple call sites, or no reusable behavior changed.
- [ ] I used Conventional Commits, worked on a policy-compliant topic branch, and kept generated/runtime data out of the change.
- [ ] I verified changed mathematical logic with an independent control, boundary cases, and counterexamples, or no mathematical logic changed.

## Compatibility

Describe API, persistence, migration, and configuration impact. Write `None` when there is no impact.

## Verification

- [ ] `pnpm verify`
- [ ] `LINGGO_FAKE_KATAGO=1 pnpm test:e2e`
- [ ] UI screenshots are attached, or no UI changed.
- [ ] Real KataGo smoke-test impact is stated, or KataGo behavior did not change.
