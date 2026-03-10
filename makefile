# ==========================================
# Prompt Lens - Polyglot Project Makefile
# ==========================================

# the path that store rust core engine
RUST_DIR = core_engine

# Declare the function that this makefile support.
.PHONY: all install build build-core build-ts clean watch-ts

# Default makefile target
all: install build

# ==========================================
# 1. Install dependency
# ==========================================
install:
	@echo "=> Installing Node.js dependencies..."
	npm install

# ==========================================
# 2. Build command
# ==========================================
build: build-core build-ts
	@echo "=> All components built successfully!"

build-core:
	@echo "=> Building Core Engine..."
	cd $(RUST_DIR) && cargo build

build-ts:
	@echo "=> Compiling TypeScript Extension..."
	npm run compile

# ==========================================
# 3. clean command
# ==========================================
clean:
	@echo "=> Cleaning VS Code Extension artifacts..."
	rm -rf node_modules out dist *.vsix
	@echo "=> Cleaning Rust artifacts..."
	cd $(RUST_DIR) && cargo clean
	@echo "=> Clean complete!"

# ==========================================
# 4. Debug mod for Developer
# ==========================================
watch-ts:
	@echo "=> Watching TypeScript files for changes..."
	npm run watch