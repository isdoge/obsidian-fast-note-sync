

# -------------------------
# PHONY 目标
# -------------------------
.PHONY: all dev ver build translate t

# 默认目标
all: test

# -------------------------
# 简单目标
# -------------------------
test:
	@echo ${REPO}

dev:
	pnpm run dev
devcss:
	pnpm run devcss
air:
	pnpm run dev

build:
	pnpm run build

# 更新版本脚本调用
ver:
	@node ./scripts/update-version.js $(filter-out $@,$(MAKECMDGOALS))

# 自动翻译 i18n
translate:
	pnpm run translate

# 别名
t: translate

# 捕获 ver 后面的参数，防止 make 将其视为目标
%:
	@:
