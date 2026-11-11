# A local model on your Mac

A task (or project) with the local model as **Model** (listed by the name of the model your Mac serves, with a laptop mark for local only) runs on your Mac and talks to a model served there, instead of Gemini through the gateway. Nothing is billed and the conversation never goes to a model in the cloud. When this Mac runs the local-LLM gateway (see below), runs use it. Without one, the daemon can start its own model server only when a request comes in and stop it when idle (`dodo model set --mlx <repo>`), or you run a server yourself and `dodo model set <url>` tells the daemon where it is.

## How it works

- The model server is any program on your Mac with the OpenAI chat completions API (`/v1/chat/completions` with `tools`): `mlx_lm.server`, LM Studio, Ollama or llama.cpp's `llama-server`.
- A run with the local model always goes to a Mac: the one the task's **Device** names, otherwise the paired Mac seen most recently (the run waits for it while it is offline). Device **Remote** is ignored for it.
- Picking Device **Remote** in the app while the local model applies (picked for the task or inherited) switches the model to the default cloud one (the inherited model when that is a cloud model, else **Auto**), since the local model can't run remotely.
- The worker on the Mac calls the gateway, or the server on this Mac (through dodo's on-demand endpoint when the daemon starts it, see below). The run's sandbox allows that the same way it allows the browser. The conversation is translated between Gemini's format (which dodo stores) and the OpenAI format both ways, tool calls included. Qwen's `<tool_call>…</tool_call>` blocks are also picked up when a server leaves them in the text.
- The agent plans with a 64k-token context and compacts the conversation before it gets there.
- A few small things still use Gemini, as before: the AI task title, **Browser: Auto**'s "does this need a browser?" question, and **Compact** pressed while no run is working (it summarises with Gemini 3.1 Flash-Lite, for a fraction of a cent). Leave Browser on None or Yes to avoid the second one.
- A model that does not call tools can't do anything in dodo, because the agent works through tools. `dodo model test` checks this.

## Setup on Arnout's Mac (Qwen3 30B-A3B, MLX)

The Hugging Face cache (`~/.cache/huggingface/hub`) holds `mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit`. That is an **MLX** checkpoint (Apple-silicon weights, 4-bit, about 17 GB), not a GGUF file, so Ollama and llama.cpp can't load it as it is. `mlx_lm.server` can, straight from the cache, without downloading it again. It is a mixture-of-experts model with 3B active parameters, so it is quick on an M-series Mac, and the Instruct-2507 version calls tools well.

One command, in the dodo checkout:

```sh
git pull && pnpm mac setup
```

`setup` finds the model in the cache, installs mlx-lm when it is missing (with `uv`, `pipx` or `pip3`), sets the model up to start on demand, and restarts the daemon. Pairing and folders stay as they are. Then, in the web app, set **Model** to the local model (its name, with the laptop mark) on a task, or as a project default under Projects. `pnpm dodo model test` loads it once and checks that it calls tools.

To pick another model later: `pnpm dodo model set --mlx <repo>`. `pnpm dodo setup --no-model` skips the model.

### The gateway first

This Mac can run a local-LLM gateway (a small launchd service set up by the [dotfiles](https://github.com/ArnoutVerboven/dotfiles/blob/main/llm/README.md)) at `http://127.0.0.1:8090/v1`. It loads the model on the first request, unloads it after 15 idle minutes, and every app on the Mac shares that one copy. dodo follows the gateway's [client contract](https://github.com/ArnoutVerboven/dotfiles/blob/main/llm/README.md#client-contract):

- Before each run the daemon asks `GET <gateway>/models` (2 s timeout). A 200 with a `data` list means it is up: the run talks to it with model `default`, and dodo starts nothing. A task set to `local:<name>` still asks for `<name>`.
- dodo never starts, stops or unloads the gateway's model.
- The gateway is `$LOCAL_LLM_URL` when the daemon has it (empty: no gateway), else `http://127.0.0.1:8090/v1`. `"gateway"` under `localModel` in `~/.dodo/config.json` overrides both: a URL, or `false` to never use one. It must be on this Mac.
- Otherwise the run uses the server set with `dodo model set`, as below.

`dodo model` and `dodo model test` say which one is in use.

### On demand: memory only while it is used

When no gateway answers, and with `--mlx` (or any server command after `--`), nothing runs and no memory is used until a run calls the model. The daemon gives the run a small private endpoint on a free port of `127.0.0.1`. Its first request starts `mlx_lm.server --model … --host 127.0.0.1 --port 8080 --chat-template-args '{"enable_thinking":false}'` (output in `~/.dodo/model.log`), waits until the model has loaded (`/health`, 20–60 s from the cache), and forwards the request. After 15 minutes without a request (`--idle <minutes>` to change it), the daemon stops the server (SIGTERM, then SIGKILL after 10 s) and the ~17 GB are free again. Requests are handled one at a time. If the gateway comes up while dodo's own server is idle, the next run stops it, so the two never hold the model at once.

If something already answers on port 8080 (a server you started yourself, LM Studio), the endpoint uses it as it is and never stops it.

Configs written before this keep working: an old `--port 8080` command without `--host`, an old `http://localhost:8080/v1`, and the old `port` field (dodo's shared endpoint on 8090 is gone, since the gateway owns that port; the field is ignored). Run `dodo model set --mlx <repo>` again to get the new command.

Sharing the model with other apps is the gateway's job now: point them at it, following the same contract.

## Other servers

| Server                  | Start                                            | `dodo model set`                                       |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| LM Studio (MLX or GGUF) | Developer tab → Start server                     | `http://localhost:1234/v1 --model <id from LM Studio>` |
| Ollama (GGUF)           | `ollama serve`, `ollama pull qwen3:30b-a3b`      | `http://localhost:11434/v1 --model qwen3:30b-a3b`      |
| llama.cpp               | `llama-server -m model.gguf --jinja --port 8080` | `http://localhost:8080/v1`                             |

`--jinja` matters for llama.cpp: without it, it does not do tool calls. A specific model can also be picked per task by setting the model to `local:<name>` (for example through the API); plain `local` uses the one `dodo model set` named.

## Commands

```sh
pnpm dodo model                      # what is set, gateway or dodo's own, and a check
pnpm dodo model set --mlx <repo> [--idle <minutes>]
pnpm dodo model set [url] [--model <name>] [-- <server command>]
pnpm dodo model test
pnpm dodo model off
```
