---
description: A skill exercising every supported frontmatter field.
when_to_use: When testing the full frontmatter schema.
allowed_tools:
  - Read
  - Bash
arguments:
  - target
  - mode
argument_hint: "<target> <mode>"
model: claude-sonnet-4-6
version: 1.2.3
disable_model_invocation: false
---

Hello from the full skill. Target is $target and mode is $mode.
