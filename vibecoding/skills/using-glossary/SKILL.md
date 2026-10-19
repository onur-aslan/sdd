---
name: using-glossary
description: Use the project glossary to keep terminology consistent during work.
disable-model-invocation: true
---

If `docs/sdd/domain-glossary.md` exists in the project, read it before starting work. Keep its term-to-code mappings in mind for the rest of the task: use the same names the glossary uses, recognize a domain term when the user mentions it, and point to the matching code instead of guessing. If the file doesn't exist, proceed normally — no need to mention it unless the user brings up domain terminology.

If the user describes a term in a way that conflicts with its glossary definition, flag the mismatch before proceeding — quote the glossary's definition, point out the difference, and ask which one should hold. Don't silently go with either version.

If a term comes up that isn't in the glossary, just do the work — don't suggest adding it unless asked.