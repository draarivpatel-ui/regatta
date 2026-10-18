# Contributing to Regatta

Thanks for your interest. Regatta is an Electron app for macOS (Electron, React, TypeScript).

## Build and run

You need macOS, Node.js 22.12 or newer, npm, and git.

```
npm ci
npm run dev
```

## Check your change

```
npm run check    # type check plus unit tests
npm run e2e      # end-to-end tests (builds the app first)
```

Run `npm run check` before opening a pull request. Run `npm run e2e` when you change something a user
can see or click. The end-to-end tests use a fake home folder and stand-in agent CLIs, so they do not
touch your real sign-ins.

## Pull requests

- Keep a pull request to one change, and say what it does and why.
- Add or update tests for the behavior you change.
- Changes to the engines that touch a user's repository (Heats, Checkpoints, Night watch, Flows, the
  Git panel, Storage) must follow [docs/design/safety.md](docs/design/safety.md): ordinary use must never
  lose work that git cannot give back. Test them with real git repositories, not mocks.
- Follow the wording and visual rules in [docs/DESIGN.md](docs/DESIGN.md).
- Do not add telemetry or any network call that sends data about a user's repositories.

## Reporting problems

Open an issue with your macOS version, what you did, what you expected, and what happened.

## License

By contributing you agree that your contribution is licensed under the MIT License in [LICENSE](LICENSE).
