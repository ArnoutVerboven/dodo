"""Run one task with the open-source browser-use library, as it ships, and print a JSON result.

browser-use owns its whole loop (its own prompt, page format and tools), so the bench runs it
as a framework rather than through the shared loop. It gets the same model, task and start
page. Input: one JSON object on stdin. Output: one JSON line on stdout.

Run through uv so nothing is installed globally:
  uv run --with browser-use==0.13.14 python browser_use_run.py < task.json
"""

import asyncio
import json
import sys
import time


async def main() -> None:
	cfg = json.load(sys.stdin)
	from browser_use import Agent, BrowserProfile, BrowserSession
	from browser_use.llm.openai.chat import ChatOpenAI

	llm = ChatOpenAI(
		model=cfg['model'],
		base_url=cfg['url'],
		api_key=cfg.get('apiKey') or 'none',
		temperature=0,
		# Local servers (mlx_lm.server, LM Studio, llama.cpp) mostly ignore response_format with a
		# JSON schema; there the schema goes into the system prompt instead.
		add_schema_to_system_prompt=not cfg.get('structuredOutput', False),
		dont_force_structured_output=not cfg.get('structuredOutput', False),
	)
	profile = BrowserProfile(
		headless=not cfg.get('headed', False),
		executable_path=cfg.get('executablePath') or None,
		chromium_sandbox=not cfg.get('noSandbox', False),
		user_agent=cfg.get('userAgent') or None,
		keep_alive=True,
		user_data_dir=None,
	)
	session = BrowserSession(browser_profile=profile)
	task = f"Start at {cfg['start']}. {cfg['goal']}"
	agent = Agent(
		task=task,
		llm=llm,
		browser_session=session,
		use_vision=cfg.get('vision', False),
		calculate_cost=False,
		max_failures=3,
		use_judge=False,
	)
	started = time.time()
	error = None
	history = None
	try:
		history = await agent.run(max_steps=cfg.get('maxSteps', 25))
	except Exception as e:  # report, do not crash the bench
		error = str(e)
	seconds = time.time() - started

	url = ''
	text = ''
	try:
		url = await session.get_current_page_url()
		page = await session.get_current_page()
		if page is not None:
			text = await page.evaluate('() => document.body ? document.body.innerText : ""')
	except Exception as e:
		error = error or f'final state: {e}'
	try:
		await session.kill()
	except Exception:
		pass

	usage = getattr(history, 'usage', None) if history is not None else None
	if history is not None and not error:
		step_errors = [e for e in history.errors() if e]
		if step_errors and not history.is_done():
			error = f'{len(step_errors)} failed steps; last: {step_errors[-1][:300]}'
	print(
		json.dumps(
			{
				'calls': history.number_of_steps() if history is not None else 0,
				'input': getattr(usage, 'total_prompt_tokens', 0) if usage else 0,
				'output': getattr(usage, 'total_completion_tokens', 0) if usage else 0,
				'cached': getattr(usage, 'total_prompt_cached_tokens', 0) if usage else 0,
				'seconds': seconds,
				'url': url,
				'text': text[:200000],
				'agentSaysDone': bool(history and history.is_done()),
				'error': error,
			}
		)
	)


asyncio.run(main())
