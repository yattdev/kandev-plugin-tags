.PHONY: build run test fmt vet package package-host clean setup check-sdk

BIN := bin/kandev-plugin-tags
VERSION := 0.8.3
STAGE := .build/stage
PKG_OUT := kandev-plugin-tags-$(VERSION).tar.gz

# go.mod keeps the sibling-repo replace used by CI and monorepo development.
# Local Makefile builds use that checkout when present; otherwise `make setup`
# creates a repo-local sparse checkout under .build/kandev and temporarily
# points the replace there for the duration of each Make target.
#   make package-host KANDEV_SDK=/path/to/kandev/apps/backend
GO_MOD_KANDEV_SDK := ../kandev/apps/backend
SETUP_KANDEV_REPO := ./.build/kandev
SETUP_KANDEV_SDK := $(SETUP_KANDEV_REPO)/apps/backend
KANDEV_SDK ?= $(if $(wildcard $(GO_MOD_KANDEV_SDK)),$(GO_MOD_KANDEV_SDK),$(SETUP_KANDEV_SDK))

# Verifies the local Kandev SDK checkout (required by go.mod's `replace`)
# is present before attempting a build, and fails fast with an actionable
# message instead of the raw Go "replacement directory ... does not exist" error.
check-sdk:
	@test -d "$(KANDEV_SDK)" || { \
		echo "ERROR: Kandev SDK not found at $(KANDEV_SDK)."; \
		echo "Run 'make setup' (sparse-clones kdlbs/kandev apps/backend into $(SETUP_KANDEV_REPO)),"; \
		echo "or see README.md > Development."; \
		echo "Override with: make <target> KANDEV_SDK=/path/to/kandev/apps/backend"; \
		exit 1; \
	}

# Sparse-clones kdlbs/kandev (apps/backend only) for Makefile builds. If the
# go.mod sibling checkout exists, this target is a no-op. Otherwise it creates
# .build/kandev by default, avoiding collisions with unrelated ../kandev dirs.
setup:
	@KSDK="$(KANDEV_SDK)"; \
	SDK_REPO="$$(dirname "$$(dirname "$$KSDK")")"; \
	if [ -d "$$KSDK" ]; then \
		echo "Kandev SDK already exists at $$KSDK."; \
	elif [ -e "$$SDK_REPO" ]; then \
		REMOTE="$$(git -C "$$SDK_REPO" remote get-url origin 2>/dev/null || true)"; \
		case "$$REMOTE" in \
			*github.com:kdlbs/kandev*|*github.com/kdlbs/kandev*) \
				echo "Configuring existing kdlbs/kandev checkout at $$SDK_REPO for apps/backend..."; \
				git -C "$$SDK_REPO" sparse-checkout set apps/backend ;; \
			*) \
				echo "ERROR: $$SDK_REPO already exists but is not a kdlbs/kandev checkout."; \
				echo "Choose another location, e.g. make setup KANDEV_SDK=./.build/kandev/apps/backend"; \
				exit 1 ;; \
		esac; \
	else \
		echo "Cloning kdlbs/kandev (apps/backend) into $$SDK_REPO..."; \
		mkdir -p "$$(dirname "$$SDK_REPO")" && \
		git clone --filter=blob:none --sparse https://github.com/kdlbs/kandev "$$SDK_REPO" && \
		git -C "$$SDK_REPO" sparse-checkout set apps/backend; \
	fi; \
	test -d "$$KSDK" || { \
		echo "ERROR: setup completed but $$KSDK was not created."; \
		exit 1; \
	}

# When KANDEV_SDK differs from the go.mod-committed sibling path, temporarily
# point the `replace` at it for the command, then restore go.mod on exit
# (success or failure) so the committed file -- and CI's `go mod tidy`
# tidiness gate -- stay untouched.
define with-sdk-override
@KSDK="$(KANDEV_SDK)"; GMOD="$(GO_MOD_KANDEV_SDK)"; tmp=""; \
trap 'rc=$$?; [ -n "$$tmp" ] && cp "$$tmp" go.mod && rm -f "$$tmp"; exit $$rc' EXIT; \
set -e; \
case "$$KSDK" in /*|./*|../*) GOMOD_KSDK="$$KSDK" ;; *) GOMOD_KSDK="./$$KSDK" ;; esac; \
if [ "$$GOMOD_KSDK" != "$$GMOD" ]; then tmp="$$(mktemp)"; cp go.mod "$$tmp"; go mod edit -replace github.com/kandev/kandev="$$GOMOD_KSDK"; fi; \
set +e; \
( $(1) ); rc=$$?; exit $$rc
endef

build: check-sdk
	$(call with-sdk-override,mkdir -p bin && go build -buildvcs=false -o $(BIN) ./server/...)

run: build
	./$(BIN)

test: check-sdk
	$(call with-sdk-override,go test ./server/...)
	node --test ui/bundle.test.js

fmt:
	gofmt -l ./server

vet: check-sdk
	$(call with-sdk-override,go vet ./server/...)

package: check-sdk
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server $(STAGE)/ui
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp README.md $(STAGE)/README.md
	cp ui/bundle.js $(STAGE)/ui/bundle.js
	$(call with-sdk-override,\
		GOOS=linux   GOARCH=amd64 go build -buildvcs=false -o $(STAGE)/server/plugin-linux-amd64       ./server && \
		GOOS=linux   GOARCH=arm64 go build -buildvcs=false -o $(STAGE)/server/plugin-linux-arm64       ./server && \
		GOOS=darwin  GOARCH=amd64 go build -buildvcs=false -o $(STAGE)/server/plugin-darwin-amd64      ./server && \
		GOOS=darwin  GOARCH=arm64 go build -buildvcs=false -o $(STAGE)/server/plugin-darwin-arm64      ./server && \
		GOOS=windows GOARCH=amd64 go build -buildvcs=false -o $(STAGE)/server/plugin-windows-amd64.exe ./server && \
		PLUGIN_ROOT="$$(pwd)" && \
		(cd "$$KSDK" && go run ./cmd/plugin-pack -dir "$$PLUGIN_ROOT/$(STAGE)" -out "$$PLUGIN_ROOT/$(PKG_OUT)"))
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

package-host: check-sdk
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server $(STAGE)/ui
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp README.md $(STAGE)/README.md
	cp ui/bundle.js $(STAGE)/ui/bundle.js
	$(call with-sdk-override,\
		go build -buildvcs=false -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server && \
		PLUGIN_ROOT="$$(pwd)" && \
		(cd "$$KSDK" && go run ./cmd/plugin-pack -dir "$$PLUGIN_ROOT/$(STAGE)" -out "$$PLUGIN_ROOT/$(PKG_OUT)" -platform-only))
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) kandev-plugin-tags-*.tar.gz
