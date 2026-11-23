#!/bin/sh
# 可选：给 FlareSolverr 挂一个 POST /login 路由（模块 /app/x1080x_login.py）。
#
# 站点登录接口强制要 Turnstile token，宿主那个共享无头浏览器签不出来，
# 需要时（看 6 小时限时窗口内的帖子）才用得上。
#
# 游客模式（BT 板块的磁力链）只需要 FlareSolverr 本身，不挂这个路由也能用：
# 镜像里没有 x1080x_login.py 时就原样启动。
#
# 做法：把 /app/flaresolverr.py 复制到可写目录，注入一行注册代码后再运行。
# /app 在镜像里是只读的（容器用户没有写权限），所以不能就地改。
set -e

if [ ! -f /app/x1080x_login.py ]; then
  echo "[entrypoint] 没有 /app/x1080x_login.py，按原样启动 FlareSolverr"
  exec python3 /app/flaresolverr.py
fi

python3 - <<'PY'
src = open('/app/flaresolverr.py').read()
marker = 'if __name__ == "__main__":'
if 'x1080x_login' not in src:
    inject = ('import x1080x_login\n'
              'x1080x_login.register(app)\n'
              '\n' + marker)
    src = src.replace(marker, inject, 1)
    open('/tmp/flaresolverr_patched.py', 'w').write(src)
    print('[entrypoint] 已注入 POST /login 路由')
else:
    open('/tmp/flaresolverr_patched.py', 'w').write(src)
PY
cd /app
PYTHONPATH=/app exec python3 /tmp/flaresolverr_patched.py
