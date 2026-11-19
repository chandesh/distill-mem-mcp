IMAGE ?= distill-mem-mcp
CONTAINER ?= distill-mem
VOLUME ?= distill_data
DATA_DIR ?= ./data

-include .env

ifndef PORT
  ifdef DISTILL_PORT
    PORT := $(DISTILL_PORT)
  else
    PORT := 8181
  endif
endif

.DEFAULT_GOAL := help

.PHONY: help init build up start down restart rebuild logs ps shell health dev test lint typecheck check db-shell backup restore stats mcp-add mcp-add-stdio mcp-inspect hooks-print clean nuke consolidate

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

init: ## Copy .env.example to .env if missing and run npm ci
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env"; fi
	npm ci

build: ## Build the Docker image
	docker build -t $(IMAGE) .

up: ## Start the stack (builds if needed) and wait for healthcheck
	docker compose up -d --build
	@echo "Waiting for healthcheck..."
	@for i in $$(seq 1 30); do \
	  if curl -sf http://127.0.0.1:$(PORT)/health >/dev/null 2>&1; then echo "healthy"; exit 0; fi; \
	  sleep 1; \
	done; \
	echo "Server did not become healthy"; exit 1

start: ## Start the stack and show the HTTP endpoint
	$(MAKE) up
	@echo "HTTP endpoint: http://127.0.0.1:$(PORT)"
	@echo "MCP endpoint:  http://127.0.0.1:$(PORT)/mcp"

down: ## Stop the stack, keep data
	docker compose down

restart: ## Restart the container (no rebuild) and show the HTTP endpoint
	docker compose restart
	@for i in $$(seq 1 30); do \
	  if curl -sf http://127.0.0.1:$(PORT)/health >/dev/null 2>&1; then \
	    echo "HTTP endpoint: http://127.0.0.1:$(PORT)"; \
	    echo "MCP endpoint:  http://127.0.0.1:$(PORT)/mcp"; \
	    exit 0; \
	  fi; \
	  sleep 1; \
	done; \
	echo "Server did not become healthy"; exit 1

rebuild: ## Rebuild the image and recreate the container
	$(MAKE) down
	$(MAKE) build
	$(MAKE) up

logs: ## Follow container logs
	docker compose logs -f

ps: ## Show container status
	docker compose ps

shell: ## Open a shell in the running container
	docker compose exec distill-mem sh

health: ## Curl /health and pretty-print
	curl -s http://127.0.0.1:$(PORT)/health | python3 -m json.tool

dev: ## Run locally with hot reload using ./data DB
	mkdir -p $(DATA_DIR)
	DISTILL_DB_PATH=$(DATA_DIR)/distill.db DISTILL_HOST=127.0.0.1 DISTILL_PORT=$(PORT) npx tsx watch src/server.ts

test: ## Run tests
	npm test

lint: ## Run lint
	npm run lint

typecheck: ## Run typecheck
	npm run typecheck

check: ## Run tests, lint, and typecheck
	$(MAKE) test
	$(MAKE) lint
	$(MAKE) typecheck

db-shell: ## Open SQLite CLI against the DB (throwaway container if no local sqlite3)
	@if command -v sqlite3 >/dev/null 2>&1; then \
	  sqlite3 $(DATA_DIR)/distill.db; \
	else \
	  docker run --rm -it -v "$(PWD)/$(DATA_DIR):/data" alpine:latest sh -c "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /data/distill.db"; \
	fi

backup: ## Write a timestamped DB backup to ./backups/
	@mkdir -p backups
	@if [ ! -f $(DATA_DIR)/distill.db ]; then echo "No DB found at $(DATA_DIR)/distill.db"; exit 1; fi
	@node -e "const Database=require('better-sqlite3');const db=new Database('$(DATA_DIR)/distill.db');const ts=new Date().toISOString().replace(/[:.]/g,'-');const dest='./backups/distill-'+ts+'.db';db.backup(dest).then(()=>{console.log('Backup written to '+dest);db.close();}).catch(e=>{console.error(e);process.exit(1);});"

restore: ## Restore from a backup: make restore FILE=./backups/x.db
	@if [ -z "$(FILE)" ]; then echo "Usage: make restore FILE=./backups/x.db"; exit 1; fi
	@read -p "Restore $(FILE) to $(DATA_DIR)/distill.db? [y/N] " ans; \
	if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then \
	  mkdir -p $(DATA_DIR); cp "$(FILE)" $(DATA_DIR)/distill.db; echo "Restored."; \
	else echo "Aborted."; fi

stats: ## Curl /stats, formatted
	curl -s http://127.0.0.1:$(PORT)/stats | python3 -m json.tool

mcp-add: ## Print the claude mcp add command (HTTP)
	@echo "claude mcp add --transport http distill-mem http://127.0.0.1:$(PORT)/mcp"

mcp-add-stdio: ## Print the claude mcp add command (stdio via docker)
	@echo "claude mcp add distill-mem -- docker run -i --rm -v $(PWD)/$(DATA_DIR):/data $(IMAGE) --transport stdio"

mcp-inspect: ## Run MCP inspector against the HTTP endpoint
	npx @modelcontextprotocol/inspector http://127.0.0.1:$(PORT)/mcp

hooks-print: ## Print hook settings snippet with absolute paths filled in
	@sed 's#__HOOKS_DIR__#$(PWD)/hooks#g' hooks/settings.snippet.json

clean: ## Remove build artifacts (backs up DB first)
	@$(MAKE) backup >/dev/null 2>&1 || true
	rm -rf dist coverage .vitest

nuke: ## Remove containers and data (with confirmation)
	@read -p "This will delete containers and $(DATA_DIR). Continue? [y/N] " ans; \
	if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then \
	  $(MAKE) backup >/dev/null 2>&1 || true; \
	  docker compose down --remove-orphans 2>/dev/null || true; \
	  rm -rf $(DATA_DIR); \
	  echo "Nuked."; \
	else echo "Aborted."; fi

consolidate: ## (stub) Run consolidation
	@echo "not implemented in v1"

