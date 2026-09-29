# 飞书招聘下拉控件诊断

日期：2026-09-29  
范围：小鹏飞书招聘页面的控件结构、当前执行器、隔离复现与现有回归。  
本轮只诊断，没有修改下拉实现，没有选择或提交真实招聘表单的答案。

## 结论

已有答案不代表已经完成控件选择。当前执行器对飞书 UD TreeSelect、多选标记和弹层归属支持不完整；部分已选值的读回也有缺口。

地点类结构缺口已通过现场 DOM 和隔离测试共同确认。普通平铺单选在隔离测试里能工作，不能把截图中所有空白单选字段都归为同一个原因。

## 1. 现场观察

通过用户提供的网址，定位到豆包浏览器内已登录的小鹏申请页面。只展开控件、读取结构，没有修改个人资料或表单答案。

- 页面混用 `atsx-select` 与 `ud__select`。意向城市采用 ATSX；截图中的基本信息下拉主要采用 UD。
- UD 的输入节点为 `input.ud__select__selector__search__input`，其 `role=combobox`；有的只读，有的可搜索。
- UD 输入与外层容器没有 `aria-controls` / `aria-owns`。弹层 `.ud__select__dropdown` 挂在控件外部。
- 普通单选的选项使用 `.ud__select__list__item`，没有标准 `role=option`。这类标记已经在当前读取器中，因此并非所有 UD 下拉都不支持。
- 地点弹层出现 `.ud__treeSelect__overlay`、`.ud__tree__node`、`.ud__checkbox__input` 和 `rc-virtual-list`；未提供标准 `role=tree` / `role=treeitem`。现场缓存的该类弹层有 9 个复选节点，却没有普通 UD 列表项。
- 期望工作地点的选择器带 `.ud__select__selector-multiple`；ATSX 的选择器带 `.atsx-select-selection--multiple`。
- 点击国籍的无障碍输入节点未展开，而点击箭头可以展开候选。这是触发区域的现场线索，不能直接等同于代码里 `selector.click()` 一定失败；后者需独立测试。

没有将现场姓名、电话、邮箱等内容写入诊断样本。

## 2. 已确认的实现缺口

### A. 树节点不会被读成选项，树适配器也没有接管

`getOptions()` 读取 `role=option/treeitem` 和若干组件列表项，其中有 `.ud__select__list__item`，但没有 `.ud__tree__node`。

`supportsCascader()` 依赖已知 Cascader 类名或标准 tree 角色，也不能覆盖这里的 UD TreeSelect。

隔离样本即使事先建立正确的弹层归属，仍然出现：实际有 2 个树节点，读取 0 个选项、树适配器不接管。传入已知答案“上海”，执行器返回 `needs-mapping`，实际点击次数为 0。

参考：

- [选项提取](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/controlObservation.ts:154)
- [树控件判断](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/cascaderAdapter.ts:51)

### B. UD 多选标记没有被识别

当前多选判断覆盖原生 multiple、ARIA、Ant/Element/Semi/Arco 等标记，但未覆盖 UD 的 `selector-multiple` 和 ATSX 的 `selection--multiple`。

在只有 UD 实际类名、没有额外 ARIA 多选属性的隔离样本中，提供两个真实存在的选项 ID，执行器仍返回“单选控件只能选择一个选项”，点击次数为 0。这个复现隔离了“多选被当成单选”的问题；不是模型给错了答案。

参考：[多选判断及拒绝条件](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/fillEngine.ts:94)

### C. 已经展开的弹层可能始终无法建立归属

对于没有 ARIA 关联的弹层，当前逻辑只在“本次点击后新出现”的候选弹层里建立关联。已展开的弹层会落入 `before` 集合，随后被排除。

隔离样本中，普通 UD 单选从关闭状态开始可正常填入；同样的控件如果弹层预先展开且尚未缓存归属，就返回 `unsupported`，点击选项次数为 0。

参考：[弹层候选过滤](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/fillEngine.ts:259)

### D. 弹层内部的复选框被误当成页面新字段

主表单扫描没有排除下拉弹层。在树样本中，一个 TreeSelect 加两个内部复选节点被扫描为 3 个控件。

这可能扩大待处理列表、增加无关的模型请求，并让用户看到不应单独处理的树选项。

参考：[控件发现](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/controlObservation.ts:225)

### E. ATSX 已选值读回需要补齐

当前选中标签读取器未覆盖 ATSX 的标签结构；当存在可编辑搜索框时，会以空值结束，而不会回退到整个控件的文本。

ATSX 同类最小样本显示“上海”，读回却为空。这个样本用于证明当前读取规则的缺口；未在真实申请页重新选择 ATSX 值，因此尚不能断言现场每次 ATSX 失败都由此引起。

参考：[已选值读取](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/src/content/controlObservation.ts:177)

## 3. 测试结果与边界

| 隔离场景 | 原执行器结果 |
| --- | --- |
| 普通 UD 平铺单选，正常新展开 | verified，1 次选项操作 |
| 同样的单选，弹层已展开但没有归属 | unsupported，0 次选项操作 |
| UD 树节点，手动建立正确弹层归属 | 树节点 2 个、可读选项 0 个，树适配器不接管 |
| 树中有“上海”，传入答案“上海” | needs-mapping，0 次选项操作 |
| 对照：只给样本节点增加标准 option 标记 | verified，1 次选项操作 |
| UD 多选，传入两个实际选项 ID | 被当作单选，拒绝执行 |
| ATSX 同类标签已显示“上海” | 读回空值 |

样本按现场观察到的结构标记搭建，调用工作区原始 `fillControl`、`observeControl`、`discoverControls`，没有改执行器。它验证具体提取和执行规则，不等同于完整复制飞书组件的所有搜索、事件和异步行为。

现有检查：

- `npm test`：269 项单元测试通过。
- 现有浏览器脚本前 26 项控件级回归通过。
- 整页浏览器回归未通过：脚本仍按旧文案“已填写 N 项，M 项需处理”提取数量并等待完成，新面板显示“网页已填写 N 项 · M 项待处理”。产生错误计数与等待超时，这批整页结果不能作为填写功能通过或失败的可靠结论。
- 现有测试没有覆盖上述 UD TreeSelect / ATSX 结构，原有回归通过也无法保证这个招聘页面可用。

参考：[旧版计数解析](/Users/chuhaonan/codeMIni-hn/Job-ApplyMate/scripts/test-form-fill.js:159)

## 4. 建议修复顺序

1. 补 UD TreeSelect 组件级适配：读节点、识别层级、区分展开与勾选、处理真实叶子选项。仅增加一个 CSS 选择器还不能解决父子选择与多选语义。
2. 补 UD / ATSX 多选判断和已选标签读回；保存与匹配使用可理解的答案，网站数字编码只属于控件操作。
3. 加强弹层生命周期处理，支持新创建、已打开、隐藏后复用三种状态；仍需证明弹层属于当前字段，不能随便选页面第一个列表。
4. 将下拉弹层、搜索框和树内复选框排除出主表单扫描，让它们只作为当前控件的内部结构处理。
5. 对虚拟列表采用展开、等待候选、搜索/按层展开、点击、独立读回的完整流程。保留取消和有限恢复预算。
6. 用真实结构补回归，并让整页测试读取稳定的会话状态、真实控件值，避免依赖界面文案。

这些应按组件实现复用，个人资料仍是全局资料，不需要新增针对小鹏网站的数据绑定规则。已有答案的失败应归为“控件未选中/未确认”，不应让用户重复补充同一份资料。

## 5. 尚不能从本次证据确认的事项

- 没有在真实页面替用户选择国籍、婚姻状况或驾照答案，因此没有逐项确认这些普通单选的最终写入。
- 没有导出真实会话的完整决策与执行轨迹，不能把每个空白字段都判定成相同错误，也不能排除某些字段本来缺资料或该次模型请求超时。
- 国籍等长列表的实际搜索响应，以及搜索是否切换为另一种结果结构，需要后续受控验证。

诊断样本与结果位于本次会话目录的 `dropdown-diagnosis` 中；仓库下拉实现文件的哈希在诊断前后保持一致。
