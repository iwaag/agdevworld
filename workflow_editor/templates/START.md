# Starting work in this authoring area

This area: {{AREA}}

1. Start the editor in a terminal and keep it running (restart it after the
   editor is updated):

       {{SERVE}}

   Then open {{URL}} in a browser.
2. Open this folder in VS Code and start the IDE agent with this folder as
   its working directory. It reads `AGENTS.md`; Claude Code reaches it
   through `CLAUDE.md`.

The tool is `{{WFE}}` (`{{WFE}} help`, `{{WFE}} run help`). The file
contract is {{CONTRACT}}; the run contract is {{RUN_CONTRACT}}.

## Authoring a project and a workflow

A first prompt:

> Create a project in this authoring area for <purpose>. Clarify its
> intent and goals, establish the repositories it needs, and create one
> workflow. Make the result available in the editor for me to review and
> adjust.

## Executing a workflow

Pick the project and the workflow in the browser (project view →
Workflows). Then, in VS Code:

> Execute workflow <workflow id> of project <project id> with the braindump
> below. Save my words as the run's braindump with me as the author, record
> the run with wfe as you work, and write your plan and reports in the run
> folder. Ask me here or as a run question when you need me.
>
> <your braindump>

- The run appears in the project view under **Runs**, at
  `{{URL}}#/ws/<project id>/run/<workflow id>/<run id>`; its folder is
  `pj-<project>/devdocs/runs/<workflow id>/<run id>/`.
- The run view shows what finished, what is active, what waits for whom,
  questions, reports and history, live. "Running" is what the agent
  recorded, not proof that it is still working; the VS Code conversation is.
- You can answer a question in the run view. That records your answer; it
  does not reach the agent by itself, so tell it here ("I answered q1").
- Accept or reject the result in the run view (Result) when you have checked it.
- `{{WFE}} run show <run>` from a project directory gives the same record in
  the terminal.
