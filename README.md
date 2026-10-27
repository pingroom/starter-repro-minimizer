# PingRoom repro minimizer

Reduce a failing configuration to a **1-minimal reproducer** with observations from a tester's phone. Start with one fixed build and 1–6 optional components, such as extensions or feature flags. The application proposes exact subsets; PingRoom asks whether each subset still shows the symptom. A JSON report records the configuration and attributed evidence.

This addresses interacting components in an unordered configuration. [Regression bisect](https://github.com/pingroom/starter-regression-bisect) instead searches an ordered series of revisions for a change boundary.

## Try it offline

Use Node 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned `@pingroom/sdk` 0.7.0 with an in-memory transport. It reduces a symptom that requires both `cache` and `compact`, then demonstrates Unknown and a symptom absent under the full configuration. Tests and demo need no credentials, phone, or network. Installation downloads the pinned package. The lockfile and `.npmrc` require releases to be at least 14 days old.

## Connect a tester

Copy the configuration and manifest:

```sh
cp config.example.json config.json
cp examples/case.json case.json
```

1. Install [PingRoom](https://pingroom.io/i). Use a private standard room containing the intended tester.
2. Run `npm run connect`, follow its pairing link, and grant that room. Connection credentials are stored privately in `.pingroom/credentials.json`.
3. Run `npm run inspect`. Verify the person in the app, then copy their exact member UUID into `config.json`.
4. Prepare a stable build and a reproducible way for the tester to enable each exact subset. Adapt `case.json` before sending any Question.

```sh
npm run plan
```

The example manifest describes a preview fixture; supply your own build and toggle procedure for a connected session. `plan` prints the declared build, baseline, instructions, component mapping, and next subset. These are your declarations; the starter does not verify the tester's installed build or environment. Make the proposed configuration available to the tester before asking them to run it.

For an existing connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Process environment takes precedence; partial pairs fail. Use the original asking registration with access to create and read its Questions. Credentials, real manifests, participant configuration, and evidence are ignored by Git.

## Run one step at a time

```sh
npm start
npm run status
```

A run creates at most one Question or reads the current Question once. The tester applies exactly the displayed subset, disables every other listed component, follows the fixed procedure, and selects **Symptom present**, **Symptom absent**, or **Unknown / untestable**. Each Question expires after 15 minutes and targets the configured UUID, also shown in its context.

After an answer, run `npm start` to read it. If the result is `ready`, use `npm run plan` to see the next subset, prepare it, and run `npm start` again to ask the next Question. There is no background Question polling or automatic external action.

The first test uses the full configuration. After a reproducing result, the algorithm tries removing one component in sorted ID order. It accepts a removal only when the smaller subset reproduces, then restarts from the first remaining component. It needs at most `1 + n(n+1)/2` Questions: 22 for six components.

```sh
npm run report
```

This exports `.repro/report.json`. `plan`, `status`, and `report` read local evidence without contacting PingRoom. Paths resolve from the project directory, even when invoked elsewhere.

| Result | Meaning |
| --- | --- |
| `complete` | The symptom was observed for `result.componentIds` and absent after every single-component removal. |
| `not_reproduced` | The symptom was absent under the initial full configuration. This is not proof the failure is impossible. |
| `inconclusive` | Unknown, expiration, cancellation, or invalid answer stopped the session. No completed result is claimed. |
| `ready` / `pending` | Prepare the next subset, or wait for the existing Question's answer. |
| `create_unknown` | Creation may have succeeded; recover the original Question before continuing. |

`bestKnownReproducer` is a previously observed reproducing subset. It is only a completed 1-minimal result when `status` is `complete`. An empty completed subset means the fixed baseline already reproduces. A 1-minimal result may still contain a smaller reproducing subset reachable by removing multiple components together; it is neither a global minimum nor proof of root cause. The algorithm requires a stable, repeatable symptom and accurate observations under the same build, baseline, and procedure. It does not require monotonic failure behavior.

Run/recovery exit codes: `0` completed, `2` inconclusive or not reproduced, `3` ready/pending/interrupted, `4` uncertain creation, `1` error. Local inspection/export commands return `0` when they successfully read a report, regardless of the session status.

## Resume safely

Keep `.repro/state.json`, the original manifest/configuration, and original credentials. Every request is saved before creation. A lost response or interruption never causes automatic reposting. Find matching recent Questions, then attach the exact ID:

```sh
npm run find-id
npm run recover -- QUESTION_UUID
```

Discovery is bounded to 200 returned Questions. An empty result does not establish that creation failed. Inspect the original registration's Questions in PingRoom if necessary; do not erase uncertain state or create a replacement. Exact candidate, request, room, target, response, asker identity, lifetime, and observation order are checked before accepting evidence. Saved history is reconstructed on every invocation. Local JSON is private state, not a tamper-proof audit log.

Pending pairing resumes through `npm run connect`. If its creation response was lost, inspect Connected Agents and resolve or revoke that registration before deliberately starting a new setup. Reconnecting cannot recover Questions owned by the old registration. If a process was killed while holding a lock, confirm no process is running before removing only the stale `.repro/.lock` or `.pingroom/.lock` directory. Preserve all state and credentials.

## Adapt it

Set `caseId`, `title`, `buildRef`, `baseline`, `instructions`, `symptom`, and unique component IDs/labels in `case.json`. IDs are lowercase slugs, at most 12 characters; labels at most 40. Text must be printable ASCII with no leading/trailing spaces: title/build reference 40 characters, baseline 60, instructions/symptom 70. Keep longer procedures in the tester's fixed build instructions and use a stable short reference here. Freeze the manifest, tester, room, and connection once a session begins. Archive a finished session before starting a new case.

The starter only proposes configurations and records observations. It never installs components, executes commands from the manifest, launches the tested application, or deploys changes. Integrate the exported JSON with your issue tracker or test harness in your own application code.

GitHub Actions runs clean installation, tests, and demo on Node 22 and 24. Tests include 276 exhaustive Boolean oracles through three components, nonmonotonic interactions, uncertainty and identity checks, CLI recovery, and the 22-Question bound. These checks use mocks; live phone delivery is not tested.

MIT licensed. See [LICENSE](LICENSE).
