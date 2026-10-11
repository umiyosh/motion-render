NPM ?= npm

.DEFAULT_GOAL := help

.PHONY: help install lint fmt fmt-check typecheck test test-coverage quality-test lint-quality lint-quality-ts quality-baseline check

help: ## Show the available targets.
	@perl -ne 'if (/^([A-Za-z0-9_.-]+):.*?##\s*(.+)$$/) { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install the Node.js dependencies.
	$(NPM) install

lint: ## Lint TypeScript with ESLint.
	$(NPM) run lint

fmt: ## Format the repository with Prettier.
	$(NPM) run fmt

fmt-check: ## Check the formatting with Prettier.
	$(NPM) run fmt-check

typecheck: ## Type-check TypeScript.
	$(NPM) run typecheck

test: ## Run the unit and render smoke tests (Vitest; the smoke tests start headless Chromium).
	$(NPM) run test:run

test-coverage: ## Run the tests with the 80% coverage gate.
	$(NPM) run test:coverage

quality-test: ## Test the quality baseline logic.
	$(NPM) run quality:test

lint-quality: ## Check the quality baseline (ESLint warnings and Knip).
	$(NPM) run quality:check

lint-quality-ts: ## Check the TypeScript quality baseline.
	$(NPM) run quality:check:ts

quality-baseline: ## Update the quality baseline from the current violations (refuses to grow it).
	$(NPM) run quality:update-baseline

check: lint fmt-check typecheck test-coverage quality-test lint-quality-ts ## Run every check that CI runs.
