# AI Infra

## Attention/Transformer

### 了解 RoPE 吗？它如何用绝对位置编码实现相对位置信息？相比 Sinusoidal 编码优势与外推性如何？

**30 秒回答**

RoPE 对 Q、K 的二维子空间按位置 m 旋转角度 mθ_i，使内积 q_m^T k_n 只依赖相对位置 m-n，从而以绝对旋转实现相对位置。相比 Sinusoidal 直接相加，RoPE 不改变向量范数、相对性内生于注意力，且可配合 NTK/YaRN 插值扩展上下文，但原生外推仍有限。

**关键点**

• 按位置对 Q/K 分对做旋转，θ_i=10000^{-2i/d}
• 内积只依赖相对位移 m-n，天然编码相对位置
• 不改变向量模长，仅旋转，保持能量
• 相比加性 Sinusoidal，相对性内生于注意力计算
• 外推需插值/缩放（NTK、YaRN），原生有限

**常见追问**

• RoPE 的频率如何设计？
• NTK-aware 插值原理？
• RoPE 与 ALiBi 的对比？

**易错点**

• 说 RoPE 是加性位置编码
• 认为 RoPE 原生无限外推
• 混淆旋转作用在 Q/K 而非 V

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 手写一个单头 Self-Attention 的核心实现。

**30 秒回答**

输入 X∈R^{n×d}，线性投影得 Q=XW_q、K=XW_k、V=XW_v；计算 scores=QK^T/sqrt(d_k)，加 mask（可选）后 softmax，再乘 V 得输出，最后可接输出投影 W_o。实现要点：缩放、mask 在 softmax 前加 -inf、维度对齐、数值稳定。

**关键点**

• Q=XW_q, K=XW_k, V=XW_v，形状 n×d_k
• scores=Q@K.T/sqrt(d_k)，mask 处填 -inf
• attn=softmax(scores, dim=-1)，out=attn@V
• 可选输出投影 out@W_o
• 注意 dtype 与数值稳定，softmax 用稳定实现

**常见追问**

• 如何扩展成多头？
• mask 如何加？
• 为什么 softmax 沿最后一维？

**易错点**

• 忘记缩放 1/sqrt(d_k)
• mask 加在 softmax 之后
• 维度转置错误导致 QK^T 形状不对

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Attention(Q,K,V) 的计算公式是什么？为什么要除以 sqrt(d_k)？如果不除，随着 d_k 增大 Softmax 输出分布会怎样变化？

**30 秒回答**

Attention=softmax(QK^T/sqrt(d_k))V。Q、K 各维近似独立、均值 0 方差 1 时，点积方差随 d_k 线性增长，量级约 sqrt(d_k)。除以 sqrt(d_k) 把 logits 方差归一到 1，避免 Softmax 饱和。不除则 d_k 增大时 logits 方差变大，Softmax 趋于 one-hot，梯度接近 0，训练不稳定。

**关键点**

• 公式：softmax(QK^T/√d_k)V，缩放作用在 logits 上
• 点积方差≈d_k，标准差≈√d_k，故除以√d_k 归一化
• 不缩放时 Softmax 输出更尖锐、接近 one-hot，熵降低
• 饱和导致梯度消失、训练不稳定，也影响数值精度
• 缩放不改变注意力排序，只改变分布平滑度

**常见追问**

• 为什么是除以 sqrt(d_k) 而不是 d_k？
• 多头注意力中每个头的 d_k 如何取？
• 温度系数与这个缩放是什么关系？

**易错点**

• 误说缩放是为了防止 QK^T 溢出，主因是 Softmax 饱和
• 把 d_k 说成序列长度
• 忽略方差假设（各维独立同分布）

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Decoder 和 Encoder 的 Attention Mask 有什么区别？

**30 秒回答**

Encoder 自注意力只用 padding mask，屏蔽 pad token，使有效 token 互相可见，无因果限制。Decoder 自注意力用因果 mask（上三角为 -inf）加 padding mask，保证第 t 个位置只能看 ≤t 的位置，防止信息泄漏。Decoder 的 cross-attention 对 encoder 输出只用 padding mask，query 侧仍受因果约束。

**关键点**

• Encoder self-attn：仅 padding mask，双向可见
• Decoder self-attn：causal mask + padding mask，单向可见
• causal mask 通常为上三角 -inf，softmax 后为 0
• Decoder cross-attn：key/value 侧用 padding mask，无因果限制
• mask 在 softmax 前加 -inf（或大负数），不是乘 0

**常见追问**

• padding mask 和 causal mask 如何合并？
• 为什么 mask 用 -inf 而不是直接置 0？
• Prefix LM 的 mask 长什么样？

**易错点**

• 说 Decoder 只用 causal mask 而忽略 padding
• 把 mask 加在 softmax 之后
• 混淆 cross-attention 的 mask 作用对象

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### LayerNorm 在 Transformer 中是在什么时候做的？

**30 秒回答**

LayerNorm 对每个 token 的隐藏维做归一化（减均值除标准差再仿射），与 batch 无关。原始 Transformer 用 Post-LN：子层输出加残差后再 LN；现代大模型多用 Pre-LN：子层输入先 LN 再过 Attention/FFN，残差直连，训练更稳定、可去掉 warmup。也有 RMSNorm 变体。

**关键点**

• 对最后一维（hidden）归一化，逐 token 独立，不跨 batch
• Post-LN：x = LN(x + Sublayer(x))，深层易不稳
• Pre-LN：x = x + Sublayer(LN(x))，训练稳定常用
• RMSNorm 去掉均值中心化，只除 RMS，更省算力
• LN 位置影响残差通路与梯度尺度

**常见追问**

• Pre-LN 和 Post-LN 的梯度差异？
• RMSNorm 与 LayerNorm 的区别？
• 为什么 LN 适合变长序列而 BN 不适合？

**易错点**

• 把 LN 说成对 batch 维归一化
• 混淆 Pre-LN/Post-LN 公式顺序
• 忽略 LN 含可学习仿射参数

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Transformer 中 Pre-Norm 和 Post-Norm 的设计差异是什么？对训练稳定性和性能有何影响？

**30 秒回答**

Post-Norm 在残差相加后做 LayerNorm，即 x = LN(x + Sublayer(x))，原始 Transformer 采用此设计，深层时梯度易不稳定，需 warmup 和精细调参；Pre-Norm 在子层输入前做归一化，即 x = x + Sublayer(LN(x))，残差路径无归一化，梯度更稳定，可训练更深模型，但同等深度下表达能力和最终性能可能略弱，常需在输出端加 final norm。

**关键点**

• Post-Norm：LN 在残差之后，梯度需穿过 LN，深层易爆炸/消失，依赖 warmup
• Pre-Norm：LN 在子层之前，残差直连，梯度稳定，适合深层大模型
• Pre-Norm 训练更稳但同深度性能可能略低，Post-Norm 收敛后性能上限可能更高
• 现代 LLM 普遍采用 Pre-Norm 或 RMSNorm 变体

**常见追问**

• 为什么 Pre-Norm 在深层网络中梯度更稳定？
• RMSNorm 和 LayerNorm 的区别是什么？
• Pre-Norm 为什么常需要 final layer norm？

**易错点**

• 把 Pre-Norm 和 Post-Norm 的公式写反
• 认为 Pre-Norm 在所有场景下性能都更好
• 忽略 warmup 与 Post-Norm 稳定性的关系

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## LLM基础

### 请阐述RAG的核心原理，并说明如何通过 RAG 缓解大模型的幻觉问题。

**30 秒回答**

RAG（检索增强生成）的核心原理是在生成前从外部知识库检索相关文档，将检索结果作为上下文输入大模型，引导生成基于事实的回复。缓解幻觉的机制包括：提供事实依据约束生成、降低模型对参数化知识的依赖、通过检索证据增强回答的可验证性。关键技术包括稠密检索、重排序、上下文融合与引用生成。

**关键点**

• 核心流程：查询编码→文档检索（稀疏/稠密）→重排序→上下文拼接→生成
• 检索器：BM25、DPR、Contriever等，支持语义匹配
• 缓解幻觉：检索证据作为生成条件，减少模型编造；引用溯源提升可信度
• 上下文融合：将检索文档与问题拼接，通过提示工程引导模型利用证据
• 挑战：检索质量影响生成效果，需处理无关文档和长上下文

**常见追问**

• 如何评估RAG系统对幻觉的缓解效果？有哪些指标？
• 检索器与生成器如何联合训练以提升端到端性能？
• 面对检索不到相关文档的情况，RAG系统应如何降级处理？

**易错点**

• 认为RAG能完全消除幻觉，实际上检索噪声和生成模型仍可能产生错误
• 忽略检索质量对生成的影响，未对检索结果进行重排序或过滤
• 上下文拼接时未考虑长度限制，导致关键信息被截断

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 请描述大模型中自然语言理解模块的具体实现方案，包括语义解析和意图识别的关键技术。

**30 秒回答**

大模型NLU模块通常以预训练语言模型为底座，通过微调或提示学习实现语义解析和意图识别。语义解析采用序列标注、图解析或生成式方法将文本映射为结构化语义表示；意图识别则通过分类头或生成式分类完成。关键技术包括上下文编码、注意力机制、指令微调、少样本学习以及多任务联合训练。

**关键点**

• 底座模型：采用BERT、RoBERTa或LLM进行上下文编码
• 语义解析：序列标注（槽位填充）、依存/成分句法分析、语义图生成（如AMR）、生成式解析（seq2seq）
• 意图识别：句子级分类（CLS头）、生成式分类（prompt+verbalizer）、多标签/层次分类
• 联合训练：多任务学习共享编码器，提升语义解析与意图识别的协同效果
• 少样本与指令微调：利用LLM的in-context learning和指令微调降低标注依赖

**常见追问**

• 如何评估语义解析和意图识别模块的性能？常用指标有哪些？
• 在低资源场景下，如何提升NLU模块的泛化能力？
• 生成式语义解析与序列标注方法各有什么优缺点？

**易错点**

• 混淆语义解析与意图识别的任务边界，未区分结构化输出与分类输出
• 忽略联合建模中任务间的相互影响，如意图识别错误导致槽位填充偏差
• 过度依赖大模型而忽视传统序列标注方法在特定场景下的效率优势

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 如何使得输入向量x经过一个或多个全连接层后，输出向量y所在子空间的基底尽可能接近标准正交基？

**30 秒回答**

可通过约束权重矩阵的奇异值或列正交性实现。常用方法：1）对权重做正交正则化，如惩罚W^T W与单位阵的差异；2）使用正交初始化；3）在训练中引入谱归一化或Stiefel流形优化；4）采用Householder变换或QR分解参数化。目标使输出协方差接近单位阵，从而子空间基底接近标准正交基。

**关键点**

• 正交正则化：损失中加入||W^T W - I||_F^2。
• 正交初始化：如SVD正交初始化或QR分解初始化。
• 谱归一化：约束权重矩阵谱范数，间接控制条件数。
• Stiefel流形优化：直接在正交矩阵集合上优化。
• 输出白化：对输出做PCA白化或ZCA白化使协方差接近单位阵。

**常见追问**

• 正交正则化与权重衰减有何区别？
• Stiefel流形优化如何实现？
• 输出子空间正交性对模型泛化有何影响？

**易错点**

• 只做初始化而不在训练中约束，正交性会退化。
• 混淆列正交与行正交。
• 忽略偏置项对输出分布的影响。

**来源**

• 腾讯：[腾讯WXG暑期实习面经-大模型算法](https://www.xiaohongshu.com/explore/69e9c830000000001b02386d?xsec_token=ABjUTjLbxsrx1oWbXwdTf4tPld9GnM-1-QgxNj3EIPuIU=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 在生成式大模型中，为何通常采用 Decoder-only 架构而非 Encoder-Decoder 结构？

**30 秒回答**

Decoder-only 用因果自注意力统一建模任意文本的下一 token 预测，训练目标简单、数据利用率高，同一架构可覆盖理解与生成任务，且 KV Cache 和推理实现统一，易于扩展和工程优化。Encoder-Decoder 需要编码器与解码器两套参数和跨注意力，结构更复杂，预训练目标设计更繁琐，在开放域生成上并未表现出明显优势，因此主流大模型多选 Decoder-only。

**关键点**

• 统一目标：因果语言建模，任意文本均可作为训练信号，数据效率高
• 架构简洁：单栈参数，易于规模化扩展和分布式训练
• 推理统一：KV Cache 和自回归解码实现简单，工程优化成熟
• Encoder-Decoder 适合输入输出边界明确的任务（翻译、摘要），但结构复杂、跨注意力增加开销

**常见追问**

• Decoder-only 做理解任务时和 Encoder 类模型相比有何劣势？
• Encoder-Decoder 在哪些任务上仍有优势？
• 因果注意力掩码如何影响并行训练效率？

**易错点**

• 绝对化地说 Encoder-Decoder 一定更差
• 忽略训练目标统一带来的数据效率优势
• 混淆因果掩码和 padding 掩码

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## RL后训练

### 大模型强化学习后训练中，PPO、DPO、GRPO 等算法的主要区别是什么？

**30 秒回答**

PPO 是 on-policy 的 actor-critic 算法，需训练 value 网络并在线采样，稳定但成本高；DPO 将 RLHF 目标转化为离线偏好数据的分类损失，无需 reward model 和在线采样，简单高效但依赖偏好数据质量；GRPO 去掉 value 网络，用组内相对奖励估计优势，适合可验证奖励的推理任务，降低显存和计算开销。

**关键点**

• PPO：on-policy，需 reward model + value model，在线采样，训练稳定但工程复杂、成本高
• DPO：离线偏好优化，将 RLHF 目标转化为分类损失，无需 reward model 和在线采样，实现简单
• GRPO：组内采样估计相对优势，去掉 value 网络，适合数学/代码等可验证奖励任务
• 选择依据：数据形态（偏好数据 vs 可验证奖励）、算力预算、是否需要在线探索

**常见追问**

• DPO 的损失函数如何推导？它和 PPO 的优化目标有什么理论联系？
• GRPO 中组大小如何影响优势估计的方差？
• PPO 训练大模型时 reward hacking 如何缓解？

**易错点**

• 把 DPO 说成 on-policy 算法
• 忽略 PPO 需要 value 网络而 GRPO 不需要这一关键差异
• 混淆 RLHF 中 reward model 训练与策略优化两个阶段

**来源**

• 腾讯：[腾讯WXG暑期实习面经-大模型算法](https://www.xiaohongshu.com/explore/69e9c830000000001b02386d?xsec_token=ABjUTjLbxsrx1oWbXwdTf4tPld9GnM-1-QgxNj3EIPuIU=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 请介绍你的强化学习相关论文，并解释GRPO、PPO、Reward Model以及马尔可夫决策过程（MDP）。

**30 秒回答**

论文围绕强化学习展开，重点涉及GRPO、PPO和Reward Model。GRPO通过组内相对优势估计避免价值网络，降低显存；PPO使用裁剪目标保证策略更新稳定；Reward Model为RLHF提供标量奖励。MDP是强化学习数学框架，由状态、动作、转移、奖励、折扣因子五元组构成，智能体通过最大化累积奖励学习策略。

**关键点**

• MDP五元组：(S, A, P, R, γ)，目标最大化期望折扣回报。
• PPO：用重要性采样和裁剪目标限制策略更新幅度，稳定训练。
• GRPO：对同一prompt采样一组输出，用组内归一化奖励作为优势，省去critic网络。
• Reward Model：基于人类偏好数据训练，为RLHF提供可微奖励信号。
• 三者关系：RM提供奖励，PPO/GRPO优化策略，MDP是理论框架。

**常见追问**

• GRPO相比PPO在实现和资源上有哪些优势与不足？
• Reward Model训练中如何避免reward hacking？
• MDP中折扣因子γ的作用是什么？

**易错点**

• 混淆PPO与GRPO的优势估计方式。
• 误认为Reward Model直接优化策略。
• 忽略MDP中转移概率的马尔可夫性假设。

**来源**

• 腾讯：[腾讯WXG暑期实习面经-大模型算法](https://www.xiaohongshu.com/explore/69e9c830000000001b02386d?xsec_token=ABjUTjLbxsrx1oWbXwdTf4tPld9GnM-1-QgxNj3EIPuIU=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### DPO 相比 PPO 有什么核心优势？

**30 秒回答**

DPO 用偏好数据直接构造分类式损失优化策略，无需显式奖励模型和在线采样，把 RL 问题转化为监督式训练。优势：流程简单、训练稳定、只需策略与参考两个模型、显存与工程成本低。代价是离线数据、缺少在线探索，对分布外偏好泛化较弱，且依赖参考模型与数据质量。

**关键点**

• 无需单独训练奖励模型，省一个模型与 RM 推理开销
• 无需在线 rollout 采样，训练像 SFT 一样简单稳定
• 损失基于偏好对的 log 概率比，隐式建模奖励
• 只需策略模型 + 参考模型，显存和调参成本低
• 缺点：离线、无探索，易受数据分布限制
• 变体：IPO、KTO、ORPO、SimPO 等改进

**常见追问**

• DPO 的损失函数推导思路是什么？
• DPO 与 PPO 在效果上何时 PPO 更优？
• β 参数在 DPO 中控制什么？

**易错点**

• 说 DPO 完全不需要参考模型（实际需要）
• 认为 DPO 一定优于 PPO，忽略在线探索价值

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### RLHF 的完整流程是怎样的？PPO 中的 Clip 机制和 KL 散度分别起什么作用？

**30 秒回答**

RLHF 流程：SFT 冷启动 → 训练奖励模型（偏好对排序损失）→ 用 PPO 以奖励模型打分优化策略，同时加 KL 惩罚约束不要偏离 SFT 模型太远。Clip 把重要性采样比限制在 [1-ε,1+ε]，防止单步更新过大导致策略崩溃。KL 项约束新策略与参考策略分布，抑制 reward hacking 和语言退化。

**关键点**

• 三阶段：SFT、奖励建模、PPO 强化学习
• 奖励模型用 pairwise 偏好数据，Bradley-Terry 损失
• PPO 目标含优势函数与重要性采样比
• Clip 截断比率，限制策略更新幅度，稳定训练
• KL 惩罚防止策略偏离参考模型，缓解 reward hacking
• 需 4 个模型：策略、参考、奖励、价值（可共享）

**常见追问**

• PPO 中优势函数怎么估计？GAE 是什么？
• KL 系数如何自适应调整？
• 奖励模型过优化（over-optimization）怎么发现？

**易错点**

• 把 Clip 说成裁剪梯度，实际裁剪重要性采样比
• 混淆参考模型与奖励模型的作用
• 忽略 KL 是相对 SFT/参考策略而非奖励模型

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## Agent

### 检索内容过多超过 Context Window 时如何解决？

**30 秒回答**

多级策略：检索侧控制召回数量并重排取 Top-K；对文档分块后按相关性筛选；用压缩/摘要（LLMLingua、抽取式摘要）缩短上下文；长上下文模型配合位置策略；分层检索先粗后细；必要时多轮迭代检索而非一次塞满。核心是提升单位 token 的信息密度。

**关键点**

• 重排（rerank）后只保留高相关 Top-K 片段
• 分块 + 相关性过滤，去掉冗余段落
• 上下文压缩：抽取式摘要或 token 级剪枝
• 使用支持长上下文的模型并注意 lost-in-the-middle
• 迭代式/多跳检索，按需补充而非一次全塞
• 分层摘要：先文档摘要再定位细节

**常见追问**

• 长上下文模型的 lost-in-the-middle 现象怎么缓解？
• 上下文压缩会带来哪些信息损失风险？

**易错点**

• 只答换更长上下文模型，忽略信息密度与成本
• 忽略重排环节直接截断

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 设计 Text-to-SQL Agent：Prompt 怎么设计？SQL 执行报错后如何自我修正？

**30 秒回答**

Prompt 包含：数据库 schema（表、列、类型、外键）、业务术语与字段映射、少量 few-shot 示例、输出格式约束（只输出 SQL）、方言与安全限制。报错修正采用反思循环：捕获错误信息与执行计划，回灌给模型分析原因（列名错、类型不匹配、语法），生成修正 SQL 重试，设最大重试次数，并可用执行结果抽样验证。

**关键点**

• Prompt 注入 schema、字段注释、术语映射与 few-shot
• 约束输出格式与 SQL 方言，限制只读防注入
• 错误处理：捕获异常信息回灌模型做根因分析
• 反思重试循环，设最大次数与回退策略
• 用 EXPLAIN 或小样本执行验证结果合理性
• 记录失败案例用于迭代 Prompt 与示例

**常见追问**

• schema 很大放不进 Prompt 怎么办？
• 如何防止生成的 SQL 做危险写操作？
• 如何评估 Text-to-SQL 的准确率？

**易错点**

• 只给表名不给列类型和注释
• 无重试上限导致死循环
• 忽略 SQL 注入与只读权限控制

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### RAG 中检索到过时或错误内容时，如何防止模型产生幻觉？

**30 秒回答**

核心是让模型对检索内容保持批判而非盲从：Prompt 要求标注来源、冲突时说明并优先高可信/新时效来源；检索侧加时间过滤、权威性排序与多源交叉验证；生成侧要求引用原文、无依据时明确说不知道；再加后置校验（NLI/事实核查）与置信度阈值，低置信拒答或转人工。

**关键点**

• Prompt 约束：要求引用来源、冲突时显式说明、不确定则拒答
• 检索侧：时效过滤、权威性加权、多路召回交叉验证
• 生成侧：答案绑定证据片段，禁止无依据扩写
• 后处理：NLI/事实一致性校验，低置信降级或转人工
• 数据治理：知识库更新机制与过期内容标记
• 评估：构造冲突/过时样本做鲁棒性测试

**常见追问**

• 如何检测检索内容之间的冲突？
• 拒答策略如何平衡召回与准确？
• RAG 幻觉评估指标有哪些？

**易错点**

• 只靠一句“不要幻觉”的 Prompt，缺少机制
• 忽略知识库时效治理

**来源**

• 字节跳动：[字节大模型算法实习面经 附答案 | 2026-02](https://www.xiaohongshu.com/explore/6984b1f2000000000e03ca15?xsec_token=ABA86MBCbp9Ji17iSV07dVExBJ3ybEC5t197jYRm84v8g=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## 多模态

### CLIP 模型的 zero-shot 能力是如何实现的？它在多模态任务中有哪些优势？

**30 秒回答**

CLIP 用图像编码器和文本编码器分别编码图像与类别描述文本，通过对比学习在图文对上对齐到同一嵌入空间。推理时把类别名构造成文本提示，计算图像嵌入与各文本嵌入的余弦相似度，取最高者分类，无需任务特定训练即可 zero-shot。优势是泛化性强、迁移成本低、支持开放词表，且图文检索和分类可统一为相似度计算。

**关键点**

• 双塔结构：图像编码器 + 文本编码器，对比学习对齐图文嵌入
• 训练目标：batch 内图文正负样本的 InfoNCE 对比损失
• zero-shot 推理：类别文本嵌入与图像嵌入算相似度做分类
• 优势：开放词表、强泛化、无需下游标注数据、统一检索与分类范式

**常见追问**

• CLIP 的对比损失中温度系数起什么作用？
• prompt engineering 对 CLIP zero-shot 精度影响有多大？
• CLIP 在细粒度分类上的局限是什么？

**易错点**

• 把 CLIP 说成生成式模型
• 忽略文本提示模板对 zero-shot 精度的影响
• 误以为 zero-shot 需要下游微调

**来源**

• 腾讯：[腾讯大模型实习一面](https://www.xiaohongshu.com/explore/69a43cfb000000001d025f9a?xsec_token=ABbwb9y2Ohwm9Ti9rnibE2xtocgtyppZcoyn7wo0UkcVI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

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

## 其他

### 面对海量数据时如何进行数据处理（如去除敏感词）？会遇到哪些问题及如何解决？

**30 秒回答**

海量数据处理需分布式并行框架（如 Spark/Flink）和分片策略。敏感词过滤可用 AC 自动机或 DFA 实现高效多模式匹配，结合布隆过滤器快速排除。常见问题包括内存不足、数据倾斜、I/O 瓶颈。解决方案：分片+流式处理、加盐打散倾斜键、列式存储与压缩、增量计算。

**关键点**

• 分布式计算框架（Spark/Flink）分片处理
• 敏感词匹配用 AC 自动机/DFA，布隆过滤器预筛
• 数据倾斜：加盐、两阶段聚合
• 内存瓶颈：流式处理、外部排序
• I/O 优化：列存、压缩、批量读写

**常见追问**

• AC 自动机的原理和构建过程？
• 布隆过滤器误判率如何控制？
• 数据倾斜的具体表现和排查方法？

**易错点**

• 忽略数据倾斜导致长尾任务
• 敏感词匹配未考虑变体（拼音、谐音）

**来源**

• 腾讯：[腾讯WXG暑期实习面经-大模型算法](https://www.xiaohongshu.com/explore/69e9c830000000001b02386d?xsec_token=ABjUTjLbxsrx1oWbXwdTf4tPld9GnM-1-QgxNj3EIPuIU=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 手撕：无重复字符的最长子串（LeetCode 3）

**30 秒回答**

使用滑动窗口+哈希表。维护窗口 [left, right] 保证无重复字符，哈希表记录字符最近出现位置。右指针遍历字符串，若当前字符已出现且位置 >= left，则更新 left = 上次位置 + 1。每次更新最大长度。时间复杂度 O(n)，空间 O(字符集大小)。

**关键点**

• 滑动窗口维护无重复子串
• 哈希表记录字符最近索引
• 左指针跳跃更新，避免重复字符
• 时间复杂度 O(n)，空间 O(min(n, 字符集))

**常见追问**

• 如果要求返回最长子串本身而非长度，如何修改？
• 字符集很大时（如 Unicode）如何优化空间？
• 如何用数组代替哈希表优化常数时间？

**易错点**

• 左指针更新时未取 max(left, 上次位置+1) 导致窗口回退
• 未考虑空字符串或单字符边界

**来源**

• 腾讯：[腾讯WXG暑期实习面经-大模型算法](https://www.xiaohongshu.com/explore/69e9c830000000001b02386d?xsec_token=ABjUTjLbxsrx1oWbXwdTf4tPld9GnM-1-QgxNj3EIPuIU=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。
