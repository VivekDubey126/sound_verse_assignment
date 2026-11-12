.PHONY: setup start dev test test-concurrent test-scenarios clean demo help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: node_modules ## Install deps, run migrations & seed plans
	@mkdir -p data data/audio
	npm run setup
	@echo "\n✅  Setup complete. Run 'make start' to launch.\n"

node_modules: package.json
	npm install

start: node_modules ## Start API server + workers
	@mkdir -p data data/audio
	@if not exist data\soundverse.db ( npm run setup )
	npm start

dev: node_modules ## Start in watch mode
	@mkdir -p data data/audio
	npm run dev

test: node_modules ## Run full test suite
	npm test

test-concurrent: node_modules ## Run concurrency tests only
	npm run test:concurrent

test-scenarios: node_modules ## Run acceptance scenario tests only
	npm run test:scenarios

demo: setup start ## One-command demo: setup + start

clean: ## Remove data, dist, node_modules
	rm -rf data/ dist/ node_modules/ coverage/
	@echo "Cleaned."

