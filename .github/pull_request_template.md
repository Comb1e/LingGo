## Behavior

Describe the user-visible or internal behavior change and link the issue.

## Engineering Policy

- [ ] I modeled every changed persistent complex workflow with an explicit state machine, or no such workflow changed.
- [ ] I placed shared and operational constants in the typed configuration modules, or no qualifying constant changed.
- [ ] I reused or introduced generic interfaces for behavior needed at multiple call sites, or no reusable behavior changed.
- [ ] I used Git commits with short lowercase imperative subjects and kept generated/runtime data out of the change.

## Compatibility

Describe API, persistence, migration, and configuration impact. Write `None` when there is no impact.

## Verification

- [ ] `pnpm verify`
- [ ] `LINGGO_FAKE_KATAGO=1 pnpm test:e2e`
- [ ] UI screenshots are attached, or no UI changed.
- [ ] Real KataGo smoke-test impact is stated, or KataGo behavior did not change.
