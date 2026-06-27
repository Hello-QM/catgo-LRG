# CatGo Privacy Policy

_Last updated: 2026-06-26_

CatGo is developed by the Wanlu Li Lab at the University of California, San Diego.
We designed CatGo to keep your work on your own device. This policy explains what
the CatGo mobile app (iPhone and iPad) does and does not do with your data.

## Summary

- **We do not collect any personal data.**
- **We do not use analytics, advertising, or tracking of any kind.**
- **We have no user accounts and require no sign-in.**
- Your files, SSH credentials, and AI model keys stay on your device.

## What stays on your device

- **Structure files and edits** you open or create are processed locally on the
  device. They are not uploaded to us.
- **SSH connection details and passwords/keys** you save (to connect to your own
  HPC clusters) are stored locally using the device's secure storage. They are
  sent only to the server *you* specify when *you* initiate a connection.
- **AI model API keys** you enter are stored locally and are sent only to the AI
  provider *you* choose (for example Anthropic, OpenAI, Google, or DeepSeek) when
  you use the assistant. We never receive them.

## Network connections you initiate

CatGo only contacts external services in response to actions you take:

- **Materials databases** — when you search, CatGo queries public scientific
  databases such as the Materials Project, OPTIMADE providers, and PubChem.
  These requests contain only your search terms (e.g. a chemical formula), not
  personal information.
- **Your HPC cluster** — when you connect, CatGo talks directly to the SSH server
  you entered.
- **Your chosen AI provider** — when you use the assistant, your prompt is sent
  directly to that provider under your own API key, subject to their privacy
  policy.

CatGo has no backend server of its own that receives your data.

## Children

CatGo is a research and education tool and is not directed at children. We do not
knowingly collect information from anyone, including children.

## Changes

If this policy changes, we will update this page and the "Last updated" date above.

## Contact

Questions: open an issue at https://github.com/Hello-QM/catgo-LRG or contact the
Wanlu Li Lab at UC San Diego.
