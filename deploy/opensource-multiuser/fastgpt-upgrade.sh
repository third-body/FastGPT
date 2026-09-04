#!/usr/bin/env bash
#
# FastGPT 备份 / 升级 / 回滚工具（可移植版）
#
# 不依赖 python3，不猜容器名——容器一律通过 `docker compose ps -q <service>` 解析，
# 数据卷通过 docker inspect 从容器挂载点反查，因此对 compose 项目名、
# 容器命名规则、服务改名都不敏感。
#
# 用法：
#   ./fastgpt-upgrade.sh backup                备份当前环境
#   ./fastgpt-upgrade.sh build [tag]           从源码构建镜像
#   ./fastgpt-upgrade.sh promote [tag]         备份 + 切换 app 镜像
#   ./fastgpt-upgrade.sh rollback <备份目录>    用备份恢复并回退镜像
#   ./fastgpt-upgrade.sh verify                健康检查与迁移状态
#   ./fastgpt-upgrade.sh doctor                部署前自检
#
# 配置：同目录下的 fastgpt-upgrade.conf，或用同名环境变量覆盖。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- 配置
[ -f "$SCRIPT_DIR/fastgpt-upgrade.conf" ] && . "$SCRIPT_DIR/fastgpt-upgrade.conf"

COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-fastgpt}"
BACKUP_ROOT="${BACKUP_ROOT:-$SCRIPT_DIR/backups}"
SRC_DIR="${SRC_DIR:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
APP_HEALTH_URL="${APP_HEALTH_URL:-http://localhost:3000/api/common/system/getInitData}"

# compose 里的服务名（不是容器名）
SVC_APP="${SVC_APP:-fastgpt-app}"
SVC_MONGO="${SVC_MONGO:-fastgpt-mongo}"
SVC_VECTOR="${SVC_VECTOR:-fastgpt-vector}"
SVC_MINIO="${SVC_MINIO:-fastgpt-minio}"
SVC_AIPROXY_PG="${SVC_AIPROXY_PG:-fastgpt-aiproxy-pg}"

# 数据库凭证与库名
MONGO_USER="${MONGO_USER:-myusername}"
MONGO_PSW="${MONGO_PSW:-mypassword}"
MONGO_DBS="${MONGO_DBS:-fastgpt fastgpt-plugin}"
PGV_USER="${PGV_USER:-username}"
PGA_USER="${PGA_USER:-postgres}"
MINIO_DATA_PATH="${MINIO_DATA_PATH:-/data}"

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 基础设施
# docker compose v2 / docker-compose v1 自适应
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "未找到 docker compose 或 docker-compose"
fi

dc() { "${DC[@]}" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"; }

# 服务名 -> 容器 ID。让 compose 自己解析，避免依赖容器命名规则。
cid() {
  local id
  id=$(dc ps -q "$1" 2>/dev/null | head -1)
  [ -n "$id" ] || die "服务 $1 未运行（compose 项目 ${COMPOSE_PROJECT}）"
  echo "$id"
}

# 从容器挂载点反查数据卷名，不靠 "<项目名>_<卷名>" 拼接
volume_of() {
  local container="$1" dest="$2" name
  name=$(docker inspect -f \
    "{{range .Mounts}}{{if eq .Destination \"$dest\"}}{{.Name}}{{end}}{{end}}" "$container")
  [ -n "$name" ] || die "容器 $container 上未找到挂载点 $dest 对应的数据卷"
  echo "$name"
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

# ---------------------------------------------------------------- doctor
do_doctor() {
  log "部署前自检"
  need_cmd docker
  ok "docker: $(docker --version | cut -d, -f1)"
  ok "compose: ${DC[*]}"

  [ -f "$COMPOSE_FILE" ] || die "compose 文件不存在：$COMPOSE_FILE"
  dc config --quiet || die "compose 语法错误"
  ok "compose 文件：$COMPOSE_FILE"

  # 4.17 起 FE_DOMAIN 必填且须为合法 URL，留空会导致应用启动即崩溃重启
  if dc config 2>/dev/null | grep -qE '^\s+FE_DOMAIN:\s*(""|'"''"')?\s*$'; then
    die "FE_DOMAIN 为空。4.17 起该变量必填且必须是合法 URL，否则应用无法启动"
  fi
  ok "FE_DOMAIN 已配置"

  local mem
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  if [ "$mem" -gt 0 ] && [ "$mem" -lt 12000000000 ]; then
    warn "Docker 可用内存 $((mem/1024/1024/1024))GB。仅在本机构建镜像时需要 ≥12GB，拉取现成镜像可忽略"
  else
    ok "内存 $((mem/1024/1024/1024))GB"
  fi

  # mongo 6+ 起 mongodump 不再内置，需单独安装 mongodb-database-tools
  local mongo_id
  if mongo_id=$(dc ps -q "$SVC_MONGO" 2>/dev/null | head -1) && [ -n "$mongo_id" ]; then
    if docker exec "$mongo_id" sh -c 'command -v mongodump' >/dev/null 2>&1; then
      ok "mongodump 可用"
    else
      die "容器内没有 mongodump。mongo 6+ 需另装 mongodb-database-tools，否则无法备份"
    fi
  else
    warn "$SVC_MONGO 未运行，跳过 mongodump 检查"
  fi

  log "自检通过"
}

# ---------------------------------------------------------------- backup
do_backup() {
  local dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  log "备份 -> $dir"
  mkdir -p "$dir"

  local mongo_id vector_id aiproxy_id minio_id
  mongo_id=$(cid "$SVC_MONGO")
  vector_id=$(cid "$SVC_VECTOR")
  aiproxy_id=$(cid "$SVC_AIPROXY_PG")
  minio_id=$(cid "$SVC_MINIO")

  # 只导业务库。绝不能带 admin/config/local：admin.system.keys 是副本集的集群时间
  # 签名密钥，恢复到另一套副本集会覆盖其自身密钥，导致全站
  # "No keys found for HMAC that is valid for time" 而接口 500。
  local db
  for db in $MONGO_DBS; do
    docker exec "$mongo_id" mongodump \
      --username "$MONGO_USER" --password "$MONGO_PSW" \
      --authenticationDatabase admin --archive --gzip --db "$db" \
      > "$dir/mongo-$db.archive.gz"
    ok "mongo/$db"
  done

  docker exec "$vector_id" pg_dumpall -U "$PGV_USER" | gzip > "$dir/pg-vector.sql.gz"
  ok "向量库"

  docker exec "$aiproxy_id" pg_dumpall -U "$PGA_USER" | gzip > "$dir/pg-aiproxy.sql.gz"
  ok "aiproxy"

  # MinIO 存的是不可变对象，只读挂载打包不影响运行中的服务
  local minio_vol
  minio_vol=$(volume_of "$minio_id" "$MINIO_DATA_PATH")
  docker run --rm -v "$minio_vol:/data:ro" -v "$dir:/backup" \
    alpine tar czf /backup/minio-data.tar.gz -C /data . 2>/dev/null
  ok "minio（卷 ${minio_vol}）"

  # 记录回滚所需的元信息
  docker inspect -f '{{.Config.Image}}' "$(cid "$SVC_APP")" > "$dir/PREVIOUS_APP_IMAGE" 2>/dev/null || true
  cp "$COMPOSE_FILE" "$dir/compose.yml.snapshot"
  printf '%s\n' "$COMPOSE_PROJECT" > "$dir/COMPOSE_PROJECT"

  echo "$dir" > "$BACKUP_ROOT/LATEST"
  log "备份完成：$dir"
}

# ---------------------------------------------------------------- restore
do_restore() {
  local dir="$1"
  [ -d "$dir" ] || die "备份目录不存在：$dir"
  log "恢复 $dir"

  local mongo_id vector_id aiproxy_id minio_id
  mongo_id=$(cid "$SVC_MONGO")
  vector_id=$(cid "$SVC_VECTOR")
  aiproxy_id=$(cid "$SVC_AIPROXY_PG")
  minio_id=$(cid "$SVC_MINIO")

  local f
  for f in "$dir"/mongo-*.archive.gz; do
    [ -f "$f" ] || continue
    # --drop 保证幂等：重复恢复不残留旧集合
    docker exec -i "$mongo_id" mongorestore \
      --username "$MONGO_USER" --password "$MONGO_PSW" \
      --authenticationDatabase admin --archive --gzip --drop < "$f"
  done
  ok "mongo"

  gunzip -c "$dir/pg-vector.sql.gz" | docker exec -i "$vector_id" psql -U "$PGV_USER" -d postgres >/dev/null
  ok "向量库"
  gunzip -c "$dir/pg-aiproxy.sql.gz" | docker exec -i "$aiproxy_id" psql -U "$PGA_USER" -d postgres >/dev/null
  ok "aiproxy"

  local minio_vol
  minio_vol=$(volume_of "$minio_id" "$MINIO_DATA_PATH")
  docker run --rm -v "$minio_vol:/data" -v "$dir:/backup" \
    alpine sh -c 'rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/minio-data.tar.gz -C /data'
  dc restart "$SVC_MINIO" >/dev/null
  ok "minio"
}

# ---------------------------------------------------------------- 改 compose 镜像
# 只替换 app 服务的 image 行。用 awk 而非宽松正则：后者会同时命中
# fastgpt-code-sandbox / fastgpt-plugin，把多个服务的镜像改成同一个。
set_app_image() {
  local file="$1" newimg="$2" svc="$3" tmp
  tmp="$(mktemp)"
  awk -v svc="$svc" -v img="$newimg" '
    # 顶层服务键：两空格缩进
    /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
      key = $0; sub(/^  /, "", key); sub(/:[[:space:]]*$/, "", key)
      in_svc = (key == svc); print; next
    }
    in_svc && /^    image:[[:space:]]/ && !done {
      print "    image: " img; done = 1; next
    }
    { print }
    END { if (!done) exit 3 }
  ' "$file" > "$tmp" || { rm -f "$tmp"; die "未在 compose 中找到服务 $svc 的 image 字段"; }
  mv "$tmp" "$file"
  ok "image -> $newimg"
}

# ---------------------------------------------------------------- build
do_build() {
  local tag="${1:-$IMAGE_TAG}"
  [ -n "$tag" ] || die "未指定镜像 tag（参数或配置 IMAGE_TAG）"
  [ -n "$SRC_DIR" ] || die "未配置 SRC_DIR（FastGPT 源码目录）"
  [ -f "$SRC_DIR/projects/app/Dockerfile" ] || die "源码目录不含 projects/app/Dockerfile：$SRC_DIR"

  local mem
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  [ "$mem" -gt 0 ] && [ "$mem" -lt 12000000000 ] && \
    warn "Docker 内存 $((mem/1024/1024/1024))GB，构建 Next.js 需 ≥12GB，可能 OOM"

  log "构建 ${tag}（源码 ${SRC_DIR}）"
  docker build -f "$SRC_DIR/projects/app/Dockerfile" -t "$tag" "$SRC_DIR"
  ok "$tag 就绪"
}

# ---------------------------------------------------------------- promote
do_promote() {
  local tag="${1:-$IMAGE_TAG}"
  [ -n "$tag" ] || die "未指定镜像 tag"
  docker image inspect "$tag" >/dev/null 2>&1 || \
    docker pull "$tag" || die "镜像不存在且拉取失败：$tag"

  do_doctor
  do_backup
  local dir; dir=$(cat "$BACKUP_ROOT/LATEST")
  warn "回滚点：$dir"

  local ts; ts=$(date +%Y%m%d-%H%M%S)
  cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak-$ts"
  ok "compose 已备份 -> $COMPOSE_FILE.bak-$ts"

  set_app_image "$COMPOSE_FILE" "$tag" "$SVC_APP"
  dc config --quiet || die "替换后 compose 语法异常，请用 $COMPOSE_FILE.bak-$ts 还原"

  dc up -d "$SVC_APP"
  log "已切换，迁移将在应用启动时自动执行"
  log "回滚：$0 rollback $dir"
}

# ---------------------------------------------------------------- rollback
do_rollback() {
  local dir="${1:-}"
  [ -n "$dir" ] || dir=$(cat "$BACKUP_ROOT/LATEST" 2>/dev/null || true)
  [ -n "$dir" ] || die "请指定备份目录"

  warn "将用 $dir 覆盖当前环境数据"
  read -r -p "确认回滚？输入 yes 继续：" a
  [ "$a" = yes ] || die "已取消"

  # 先停应用，避免恢复过程中有写入
  dc stop "$SVC_APP"

  if [ -f "$dir/PREVIOUS_APP_IMAGE" ]; then
    set_app_image "$COMPOSE_FILE" "$(cat "$dir/PREVIOUS_APP_IMAGE")" "$SVC_APP"
  fi

  do_restore "$dir"
  dc up -d "$SVC_APP"
  ok "回滚完成"
}

# ---------------------------------------------------------------- verify
do_verify() {
  log "服务状态"; dc ps

  log "等待应用就绪"
  local i code=000
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$APP_HEALTH_URL" 2>/dev/null || echo 000)
    [ "$code" = 200 ] && break
    sleep 10
  done
  [ "$code" = 200 ] && ok "应用就绪 (200)" || warn "应用未就绪（HTTP ${code}），见下方日志"

  log "迁移状态"
  local mongo_id; mongo_id=$(cid "$SVC_MONGO")
  local shell; shell=$(docker exec "$mongo_id" sh -c 'command -v mongosh || command -v mongo' | head -1)
  [ -n "$shell" ] || { warn "容器内无 mongo/mongosh，跳过迁移检查"; return; }
  docker exec "$mongo_id" "$shell" -u "$MONGO_USER" -p "$MONGO_PSW" \
    --authenticationDatabase admin fastgpt --quiet --eval '
      if (db.getCollectionNames().indexOf("system_migration_states") < 0) {
        print("   尚未生成迁移记录");
      } else {
        var bad = 0;
        db.system_migration_states.find().forEach(function (d) {
          print("   " + (d.status === "succeeded" ? "OK  " : "!!  ") + d._id + " " + d.status);
          if (d.status !== "succeeded") bad++;
        });
        print(bad === 0 ? "   全部迁移成功" : "   有 " + bad + " 个迁移未成功");
      }' 2>/dev/null || warn "迁移状态查询失败"

  log "近期错误日志"
  dc logs --since 5m "$SVC_APP" 2>&1 | grep -iE "\bERR\b|error:" | tail -10 || echo "   无"
}

case "${1:-}" in
  doctor)   do_doctor ;;
  backup)   do_backup ;;
  build)    do_build "${2:-}" ;;
  promote)  do_promote "${2:-}" ;;
  rollback) do_rollback "${2:-}" ;;
  verify)   do_verify ;;
  *) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
