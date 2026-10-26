# Manual maintenance

Maintenance is on demand. Do not add schedules, Dependabot configuration or
recurring automation without an explicit project-owner decision.

For an authorized maintenance pass, check actual issues and pull requests,
security alerts, dependency audit output, the current main commit's CI, and the
Pages deployment commit. Preserve local changes. Reuse recent tests when the
exact source commit and dependencies are unchanged; state when evidence is reused.

For a code or dependency change, run the README verification commands. Review
the packed archive for its worker and HTML assets and run the installed package
smoke. Do not release or create a commit solely to show maintenance activity.

Publishing is a separate deliberate step. Verify the release asset hashes and
current-commit CI/Pages after publication. Keep synthetic examples separate from
claims about any provider's effective validation behavior.
