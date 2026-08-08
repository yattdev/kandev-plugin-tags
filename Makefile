.PHONY: build run test fmt vet package package-host clean setup check-sdk

BIN := bin/kandev-plugin-tags
VERSION := 0.1.2
STAGE := .build/stage
PKG_OUT := kandev-plugin-tags-$(VERSION).tar.gz

# Path to a local checkout of github.com/kandev/kandev's apps/backend,
# matching go.mod's `replace github.com/kandev/kandev => ../kandev/apps/backend`.
# Override for a non-standard layout, e.g.:
#   make package-host KANDEV_SDK=/path/to/kandev/apps/backend
DEFAULT_KANDEV_SDK := ../kandev/apps/backend
KANDEV_SDK ?= $(DEFAULT_KANDEV_SDK)

# Verifies the local Kandev SDK checkout (required by go.mod's `replace`)
# is present before attempting a build, and fails fast with an actionable
# message instead of the raw Go "replacement directory ... does not exist" error.
check-sdk:
	@test -d "$(KANDEV_SDK)" || { \
		echo "ERROR: Kandev SDK not found at $(KANDEV_SDK)."; \
		echo "Run 'make setup' (clones kdlbs/kandev apps/backend into ../kandev),"; \
		echo "or see README.md > Development."; \
		echo "Override with: make <target> KANDEV_SDK=/path/to/kandev/apps/backend"; \
		exit 1; \
	}

# Sparse-clones kdlbs/kandev (apps/backend only) into ../kandev so go.mod's
# local `replace` directive resolves. No-ops if ../kandev already exists.
setup:
	@if [ -d ../kandev ]; then \
		echo "../kandev already exists -- skipping clone."; \
	else \
		echo "Cloning kdlbs/kandev (apps/backend) into ../kandev..."; \
		git clone --filter=blob:none --sparse https://github.com/kdlbs/kandev ../kandev && \
		git -C ../kandev sparse-checkout set apps/backend; \
	fi

# When KANDEV_SDK differs from the go.mod-committed default, temporarily
# point the `replace` at it for the build, then restore go.mod on exit
# (success or failure) so the committed file -- and CI's `go mod tidy`
# tidiness gate -- stay untouched.
define with-sdk-override
@KSDK="$(KANDEV_SDK)"; DEFAULT="$(DEFAULT_KANDEV_SDK)"; rc=0; \
if [ "$$KSDK" != "$$DEFAULT" ]; then go mod edit -replace github.com/kandev/kandev=$$KSDK; fi; \
trap '[ "$$KSDK" != "$$DEFAULT" ] && git checkout -- go.mod; exit $$rc' EXIT; \
( $(1) ); rc=$$?
endef

build: check-sdk
	$(call with-sdk-override,mkdir -p bin && go build -o $(BIN) ./server/...)

run: build
	./$(BIN)

test:
	go test ./server/...
	node --test ui/bundle.test.js

fmt:
	gofmt -l .

vet:
	go vet ./server/...

package: check-sdk
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server $(STAGE)/ui
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp README.md $(STAGE)/README.md
	cp ui/bundle.js $(STAGE)/ui/bundle.js
	$(call with-sdk-override,\
		GOOS=linux   GOARCH=amd64 go build -o $(STAGE)/server/plugin-linux-amd64       ./server && \
		GOOS=linux   GOARCH=arm64 go build -o $(STAGE)/server/plugin-linux-arm64       ./server && \
		GOOS=darwin  GOARCH=amd64 go build -o $(STAGE)/server/plugin-darwin-amd64      ./server && \
		GOOS=darwin  GOARCH=arm64 go build -o $(STAGE)/server/plugin-darwin-arm64      ./server && \
		GOOS=windows GOARCH=amd64 go build -o $(STAGE)/server/plugin-windows-amd64.exe ./server && \
		go run github.com/kandev/kandev/cmd/plugin-pack -dir $(STAGE) -out $(PKG_OUT))
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

package-host: check-sdk
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server $(STAGE)/ui
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp README.md $(STAGE)/README.md
	cp ui/bundle.js $(STAGE)/ui/bundle.js
	$(call with-sdk-override,\
		go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server && \
		go run github.com/kandev/kandev/cmd/plugin-pack -dir $(STAGE) -out $(PKG_OUT) -platform-only)
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) kandev-plugin-tags-*.tar.gz
