DEV_CONFIG_DIR := /opt/soma-work/dev

# Local dev: run local source with /opt/soma-work/dev configs
up:
	@echo "Starting local dev with $(DEV_CONFIG_DIR) configs..."
	SOMA_CONFIG_DIR=$(DEV_CONFIG_DIR) npx tsx src/index.ts

# Stop local dev process
down:
	@echo "Stopping local dev..."
	@lsof -ti:3000 | xargs kill 2>/dev/null || true

# Build TypeScript
build:
	npm run build

# Run tests
test:
	npx vitest run

# Setup /opt directories (first-time only)
setup:
	./service.sh main setup
	./service.sh dev setup

.PHONY: up down build test setup
