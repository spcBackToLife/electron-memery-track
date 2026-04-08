# bare-minimum

**Electron 裸启动基线**

验证问题：启动一个 Electron app 的最低内存开销是多少？

### 控制变量
- 无任何页面加载（about:blank）
- 无 preload 脚本
- 无 React/Vite 构建产物
- 仅一个 BrowserWindow

### 运行
```bash
cd apps/bare-minimum
pnpm dev
```

### 预期观察点
- 主进程 (Browser) 内存基线
- GPU 进程内存基线
- Utility 进程内存基线
- 空白渲染进程内存基线
- V8 堆初始大小
