# AI Infra

## 模型压缩

### 简述 LoRA 原理。原权重 W 为 d×d、秩 r，参数量减少多少？A、B 如何初始化，为什么？

**30 秒回答**

LoRA 冻结原权重 W，用低秩分解 ΔW=BA 近似更新，B∈R^{d×r}、A∈R^{r×d}，前向为 Wx+BAx。原参数 d²，新增 2dr，占比 2r/d。A 用高斯随机初始化，B 初始化为 0，使训练开始时 BA=0，模型输出与原模型一致，避免初始扰动。

**关键点**

• 冻结 W，仅训练低秩 BA，推理可合并回 W
• 新增参数 2dr，相对 d² 的比例为 2r/d
• A 随机高斯初始化，B 置零，保证初始 ΔW=0
• 缩放因子 α/r 控制更新幅度
• 可多任务切换不同 LoRA，部署灵活

**常见追问**

• LoRA 的 rank 如何选？
• α 的作用是什么？
• QLoRA 与 LoRA 的区别？

**易错点**

• 说 A、B 都随机初始化
• 把参数量减少说成 d²-2dr 的绝对差而非比例
• 忽略 B 置零是为了初始恒等

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## 推理Infra

### 推理时为什么要用 KV Cache？显存占用怎么计算？介绍 MQA 和 GQA，以及 GQA 在显存带宽与计算量之间的权衡。

**30 秒回答**

自回归解码每步只生成一个 token，若不缓存则需重算全部历史 K/V，复杂度 O(n²)。KV Cache 缓存历史 K/V，使每步只算新 token 的 Q 与全部 K/V 做注意力，把重复计算换成显存。占用约为 2×层数×batch×序列长×KV头数×head_dim×字节数。MQA 所有 Q 头共享一组 K/V，GQA 按组共享，介于 MHA 与 MQA 之间。

**关键点**

• 无缓存时每步重算历史 K/V，总计算 O(n²)；缓存后每步 O(n)
• 显存公式：2( K和V )×L层×B×S×H_kv×d_head×精度字节
• MHA 每头独立 K/V，MQA 全部头共享一组，GQA 分组共享
• GQA 减少 KV 头数，显著降低 KV Cache 显存与解码时的带宽压力
• 计算量略增（Q 头仍多），但解码是带宽瓶颈，收益大于代价
• Llama2/3、Qwen 用 GQA 以较小质量损失换长上下文与高并发

**常见追问**

• GQA 的 group 数怎么选？和模型质量、吞吐的关系？
• PagedAttention 如何管理 KV Cache 显存碎片？
• KV Cache 量化（INT8/FP8）有什么风险？

**易错点**

• 漏乘 2（K 和 V 两份）
• 把 KV 头数误当成 Q 头数
• 认为 GQA 减少计算量，实际主要减显存与带宽

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 针对 Transformer 模型推理过程，你会采用哪些优化手段？

**30 秒回答**

Transformer推理优化可从计算、内存、调度三方面入手：计算上采用算子融合、量化（INT8/FP16）、稀疏化与蒸馏；内存上使用KV Cache、PagedAttention、权重共享与低秩分解；调度上采用连续批处理、投机解码与并行解码。此外，编译优化（如TensorRT、TVM）和硬件适配（GPU/TPU）也能显著提升吞吐与降低延迟。

**关键点**

• 计算优化：算子融合（LayerNorm+Linear）、量化（FP16/INT8/FP8）、知识蒸馏、剪枝与稀疏化
• 内存优化：KV Cache复用、PagedAttention分页管理、权重低秩分解、激活重计算
• 调度优化：连续批处理（Continuous Batching）、动态批处理、投机解码（Speculative Decoding）
• 编译与部署：TensorRT、TVM、ONNX Runtime等图优化与硬件特定内核
• 并行策略：张量并行、流水线并行用于大模型多卡推理

**常见追问**

• KV Cache 的显存占用如何计算？如何优化长上下文场景下的 KV Cache？
• 量化推理中如何平衡精度与速度？有哪些常见的量化方法？
• 投机解码的原理是什么？它如何保证输出分布不变？

**易错点**

• 只关注计算优化而忽略内存带宽瓶颈，实际推理中内存访问常是主要瓶颈
• 量化时未考虑激活值动态范围，导致精度显著下降
• 混淆训练优化与推理优化，如将梯度检查点用于推理场景

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### vLLM 框架的核心优化原理是什么？其在动态批处理和显存管理上有哪些创新设计？

**30 秒回答**

vLLM的核心优化原理是PagedAttention，将KV Cache分页管理，像操作系统虚拟内存一样按需分配，消除显存碎片。动态批处理采用连续批处理（Continuous Batching），在迭代级别调度请求，新请求可随时加入批次。显存管理通过块表映射逻辑块与物理块，支持KV Cache共享与高效回收，显著提升吞吐量。

**关键点**

• PagedAttention：将KV Cache划分为固定大小的块，通过块表实现非连续存储
• 显存管理：按需分配物理块，减少碎片，支持前缀共享（如系统提示词）
• 连续批处理：以迭代为粒度调度，动态合并新请求，提高GPU利用率
• 吞吐提升：相比传统批处理，vLLM在相同硬件上吞吐量可提升数倍
• 内存回收：请求完成后立即释放块，避免显存浪费

**常见追问**

• PagedAttention 如何处理注意力计算中的非连续内存访问？
• 连续批处理与静态批处理相比，在延迟和吞吐上有何权衡？
• vLLM 如何实现前缀共享？在哪些场景下收益最大？

**易错点**

• 将PagedAttention简单理解为分页存储，忽略其块表映射和共享机制
• 认为连续批处理总是优于静态批处理，未考虑请求长度差异对调度的影响
• 忽略块大小对性能的影响，块过大导致内部碎片，块过小增加管理开销

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## 训练Infra

### 微调大模型时常用哪些框架？它们的优缺点分别是什么？

**30 秒回答**

常用 HuggingFace Transformers/PEFT、DeepSpeed、Megatron-LM、LLaMA-Factory、Unsloth 等。Transformers+PEFT 生态全、上手快，但大规模训练效率一般；DeepSpeed 支持 ZeRO 显存优化，配置较复杂；Megatron-LM 张量/流水并行效率高，但代码门槛高；LLaMA-Factory 封装好、适合快速实验；Unsloth 对单卡 LoRA 有显存和速度优化。

**关键点**

• Transformers + PEFT：生态完善、LoRA/QLoRA 易用，适合中小规模微调
• DeepSpeed：ZeRO 分片降低显存，支持大规模分布式，但配置和调试成本高
• Megatron-LM：张量并行/流水并行效率高，适合千卡级预训练，代码侵入性强
• LLaMA-Factory/Unsloth：封装度高、实验快，但定制化和超大规模支持有限

**常见追问**

• ZeRO 的 stage 1/2/3 分别切分了什么？
• LoRA 和 QLoRA 的区别是什么？QLoRA 如何降低显存？
• 张量并行和流水并行分别适合什么场景？

**易错点**

• 只列框架名不说适用规模
• 把 DeepSpeed 的 ZeRO 和模型并行混为一谈
• 忽略框架在千卡规模下的通信开销差异

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。
