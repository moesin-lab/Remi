# 多 UID guest 复验

在一次性 Linux guest 内以 guest root 执行。需要已挂载的 `/proc`、可写的 `/tmp`、Python 3.9+、glibc 和仓库固定版本的 Bun。guest 需支持 UID/GID 1001、1002、1003 以及清空附加组。将仓库和 Bun 放在三个 guest 用户均可遍历的路径，从仓库根目录运行：

```sh
bun run test ./tests/unit/daemon/root-machine-ipc.guest.ts
```

这是显式调用的 guest 测试入口。夹具在 `/tmp` 新建专用目录，将当前 checkout 的真实客户端和服务端打包。UID 1001 生成测试身份及一次性 RSA、Ed25519 密钥并监听 Unix stream socket。每条连接启动同一服务入口，从 fd 0 获取真实 peer credentials。运行结束后清理临时目录。

先用 UID 1002 的独立 socket 客户端核对一次 `publicBinding`。随后依次以 1002、1003、1002 调用真实 `RootMachineClient` 的两个方法。1002 应得到完整 camelCase 公共绑定，以及 nonce、接收密钥指纹和 Ed25519 签名均通过核验的挑战回复。1003 应收到两次明确的 `Machine operation denied`；直接读取 `binding.json`、`recipient.pem`、`signing.pem` 应分别得到 `EACCES`。测试日志会分别报告 IPC 断言和文件读取结果。
