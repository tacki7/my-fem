# Host-native (no container) --------------------------------------------------
dev:            ## vite dev server on :5173
	npm run dev
build:          ## typecheck + production build into dist/
	npm run build

# Containerised (needs docker or podman) --------------------------------------
docker-dev:     ## dev server in a container on :5173
	docker compose up --build dev
docker-serve:   ## production build served by nginx on :8080
	docker compose --profile prod up --build serve
docker-clean:
	docker compose down -v --remove-orphans

.PHONY: dev build docker-dev docker-serve docker-clean
