# A local model on your Mac

A task (or project) with **Model: Local model (your Mac, free)** runs on your Mac and talks to a model served there, instead of Gemini through the gateway. Nothing is billed and the conversation never goes to a model in the cloud. The daemon can start the model server only when a request comes in and stop it when idle (`dodo model set --mlx <repo>`), or you run a server yourself and `dodo model set <url>` tells the daemon where it is.

## How it works

- The model server is any program on your Mac with the OpenAI chat completions API (`/v1/chat/completions` with `tools`): `mlx_lm.server`, LM Studio, Ollama or llama.cpp's `llama-server`.
- A run with the local model always goes to a Mac: the one the task's **Device** names, otherwise the paired Mac seen most recently (the run waits for it while it is offline). Device **Remote** is ignored for it.
- The worker on the Mac calls the server on `localhost` (through the on-demand endpoint when there is one, see below). The run's sandbox allows that the same way it allows the browser. The conversation is translated between Gemini's format (which dodo stores) and the OpenAI format both ways, tool calls included. Qwen's `<tool_call>…</tool_call>` blocks are also picked up when a server leaves them in the text.
- The agent plans with a 64k-token context and compacts the conversation before it gets there.
- A few small things still use Gemini, as before: the AI task title, **Browser: Auto**'s "does this need a browser?" question, and **Compact** pressed while no run is working (it summarises with Gemini 3.1 Flash-Lite, for a fraction of a cent). Leave Browser on None or Yes to avoid the second one.
- A model that does not call tools can't do anything in dodo, because the agent works through tools. `dodo model test` checks this.

## Setup on Arnout's Mac (Qwen3 30B-A3B, MLX)

The Hugging Face cache (`~/.cache/huggingface/hub`) holds `mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit`. That is an **MLX** checkpoint (Apple-silicon weights, 4-bit, about 17 GB), not a GGUF file, so Ollama and llama.cpp can't load it as it is. `mlx_lm.server` can, straight from the cache, without downloading it again. It is a mixture-of-experts model with 3B active parameters, so it is quick on an M-series Mac, and the Instruct-2507 version calls tools well.

1. Install mlx-lm (once):

   ```sh
   pip3 install -U mlx-lm        # or: uv tool install mlx-lm / pipx install mlx-lm
   ```

2. Tell dodo to run it on demand, then check that it calls tools:

   ```sh
   pnpm dodo model set --mlx mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit
   pnpm dodo model test
   ```

3. In the web app, set **Model** to **Local model (your Mac, free)** on a task, or as a project default under Projects.

### On demand: memory only while it is used

With `--mlx` (or any server command after `--`), nothing runs and no memory is used until a request comes in. The daemon serves a small endpoint at `http://localhost:8090/v1`. Its first request starts `mlx_lm.server --model … --port 8080` (output in `~/.dodo/model.log`), waits until the model has loaded (20–60 s from the cache), and forwards the request. After 10 minutes without a request (`--idle <minutes>` to change it), the daemon stops the server and the ~17 GB are free again. Requests are handled one at a time.

If something already answers on port 8080 (a server you started yourself, LM Studio), the endpoint uses it as it is and never stops it.

### Sharing the model with other apps

Each process that loads the model holds its own copy in memory, so two apps that each load it cost twice the memory. To keep one copy, point other apps at the same endpoint, `http://localhost:8090/v1` (the OpenAI chat completions API), instead of loading the model themselves. They then get the same start-on-demand and stop-when-idle behaviour. If the dodo daemon isn't running, nothing answers there, so an app should fall back to loading the model itself.

## Other servers

| Server                  | Start                                            | `dodo model set`                                       |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| LM Studio (MLX or GGUF) | Developer tab → Start server                     | `http://localhost:1234/v1 --model <id from LM Studio>` |
| Ollama (GGUF)           | `ollama serve`, `ollama pull qwen3:30b-a3b`      | `http://localhost:11434/v1 --model qwen3:30b-a3b`      |
| llama.cpp               | `llama-server -m model.gguf --jinja --port 8080` | `http://localhost:8080/v1`                             |

`--jinja` matters for llama.cpp: without it, it does not do tool calls. A specific model can also be picked per task by setting the model to `local:<name>` (for example through the API); plain `local` uses the one `dodo model set` named.

## Commands

```sh
pnpm dodo model                      # what is set, and a check
pnpm dodo model set --mlx <repo> [--idle <minutes>] [--port <n>]
pnpm dodo model set [url] [--model <name>] [-- <server command>]
pnpm dodo model test
pnpm dodo model off
```
