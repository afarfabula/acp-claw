# 大模型/Agent

## Attention/Transformer

### 多头拼接后，为什么通常要调用contiguous()？

**30 秒回答**

transpose等操作只改变张量的视图而不复制数据，导致内存不连续。contiguous()将张量复制为连续内存布局，确保后续view或reshape操作能正确工作，避免报错或性能下降。

**关键点**

• transpose/permute返回非连续视图
• view/reshape要求内存连续
• contiguous()触发实际内存拷贝
• 保证后续操作正确性
• 可能带来额外开销，但通常必要

**常见追问**

• contiguous()和view()的区别？
• 什么情况下不需要contiguous()？
• 如何避免不必要的contiguous调用？

**易错点**

• 认为contiguous()总是必须的，其实reshape可自动处理
• 忽略非连续张量对性能的影响

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

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

### 缩放点积注意力的原理是什么？

**30 秒回答**

缩放点积注意力将查询Q与键K做点积得到相似度分数，除以√d_k进行缩放，再经softmax归一化为注意力权重，最后对值V加权求和。缩放防止点积过大导致softmax梯度消失，使训练更稳定。

**关键点**

• 计算QK^T得到相似度矩阵
• 除以√d_k缩放，避免softmax饱和
• softmax归一化为注意力权重
• 权重与V加权求和得到输出
• 缩放因子使方差稳定，梯度更健康

**常见追问**

• 为什么缩放因子是√d_k而不是d_k？
• 如果不做缩放会有什么后果？
• 缩放点积注意力与加性注意力的区别？

**易错点**

• 误以为缩放是为了归一化数值范围，实际是控制方差
• 忘记softmax是在最后一维进行

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Attention 计算公式中为什么要除以 sqrt(d_k)？

**30 秒回答**

缩放点积注意力中，Q 和 K 的每个维度独立同分布且均值为 0、方差为 1 时，点积的方差为 d_k。当 d_k 较大时，点积结果方差大，softmax 输入绝对值大，导致梯度极小（饱和），训练困难。除以 sqrt(d_k) 将方差归一化到 1，使 softmax 输出更平滑，梯度更稳定。

**关键点**

• 点积方差随维度 d_k 线性增长，导致 softmax 饱和
• softmax 饱和时梯度接近 0，参数难以更新
• 缩放因子 sqrt(d_k) 将方差归一化，保持梯度稳定
• 该缩放不改变注意力分布的相对排序，仅调整温度

**常见追问**

• 如果不缩放，除了梯度消失还有什么问题？
• 缩放因子为什么是 sqrt(d_k) 而不是 d_k？
• 在多头注意力中，每个头的 d_k 较小，缩放还有必要吗？

**易错点**

• 误以为缩放是为了防止数值溢出（实际主要防梯度消失）
• 忽略假设条件（独立同分布、零均值、单位方差）

**来源**

• 字节跳动：[字节大模型实习算法岗一二面经](https://www.xiaohongshu.com/explore/69384734000000001e022ec0?xsec_token=ABwvlFtHr9yyswgc35gRusFkPon2zfukm9veI5JfGFAws=&xsec_source=pc_search)

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

### Q、K、V投影并分头后，transpose(1, 2)的作用是什么？

**30 秒回答**

transpose(1,2)将张量从(batch, seq_len, num_heads, head_dim)转换为(batch, num_heads, seq_len, head_dim)，使每个注意力头独立在序列维度上计算注意力分数，符合多头注意力并行计算的需求。

**关键点**

• 输入形状通常为(batch, seq_len, num_heads, head_dim)
• transpose(1,2)交换序列维和头维
• 输出形状为(batch, num_heads, seq_len, head_dim)
• 便于每个头独立计算QK^T和softmax
• 是PyTorch实现多头注意力的标准操作

**常见追问**

• 如果不transpose直接计算注意力会怎样？
• transpose后为什么有时需要contiguous？
• 多头注意力的计算图如何理解？

**易错点**

• 混淆transpose的维度索引（从0开始）
• 误以为transpose会改变内存布局，实际只改变视图

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

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

### 了解 Gist 吗？它是如何压缩提示信息的？

**30 秒回答**

Gist 是一种提示压缩技术，通过训练一个编码器将长提示压缩成少量 gist token，这些 token 作为软提示输入给 LLM。压缩时使用自编码器或注意力蒸馏，让 gist token 保留原提示的关键信息，从而减少计算和内存开销。

**关键点**

• Gist token 是连续向量，不是离散 token，可大幅缩短序列长度。
• 训练目标包括重构损失和任务损失，确保压缩后信息不丢失。
• 压缩率由 gist token 数量控制，需在效果和效率间权衡。
• 适用于长上下文场景，如文档问答、多轮对话。

**常见追问**

• Gist 压缩和普通池化（如 mean pooling）有什么区别？
• 如何评估 gist 压缩后的信息保留程度？

**易错点**

• 误以为 gist token 是词表中的离散 token。
• 忽略压缩后可能丢失细粒度信息，导致下游任务性能下降。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

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

### 有看过最新的技术报告吗？讲一讲 DeepSeek 和 Qwen 模型的区别？

**30 秒回答**

DeepSeek 和 Qwen 都是国内领先的开源大模型系列。DeepSeek 强调 MoE 架构和高效训练，如 DeepSeek-V2 采用 MLA 和 DeepSeekMoE；Qwen 系列覆盖稠密和 MoE，注重多语言和多模态能力。两者在架构、训练数据配比和开源策略上各有侧重。

**关键点**

• DeepSeek 使用 MLA（多头潜在注意力）和 DeepSeekMoE 提升推理效率。
• Qwen 提供从 0.5B 到 72B 的稠密模型及 MoE 版本，生态完整。
• DeepSeek 训练数据中英文比例均衡，Qwen 多语言能力更强。
• 两者均开源模型权重，但许可证和商用条件不同。

**常见追问**

• MLA 和 GQA 在推理效率上有何差异？
• MoE 模型在训练和推理时面临哪些挑战？

**易错点**

• 混淆 DeepSeek-V2 和 V3 的架构细节。
• 笼统比较而忽略具体版本和参数规模。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

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

### Pass@1、Pass@k分别是什么意思？

**30 秒回答**

Pass@1指模型第一次生成就正确的概率；Pass@k指模型生成k个样本中至少有一个正确的概率。常用于代码生成评估，Pass@k衡量模型多样性下的潜在能力。

**关键点**

• Pass@1：单次生成正确率。
• Pass@k：k次采样中至少一次正确的概率。
• 计算公式：1 - C(n-c, k)/C(n, k)，n为总样本数，c为正确样本数。
• Pass@k随k增大而提高，反映模型探索能力。

**常见追问**

• 如何无偏估计Pass@k？
• Pass@k与温度参数的关系？

**易错点**

• 误以为Pass@k是k次平均正确率。
• 忽略采样策略对Pass@k的影响。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## 预训练

### 训练数据需要扩大十倍、百倍时，如何扩展数据构建与筛选流程？

**30 秒回答**

需构建自动化数据流水线：利用规则/模型进行粗筛和精筛，引入主动学习或聚类去重，采用分布式处理提升吞吐，并设计可扩展的质量评估体系，同时人工抽检保证质量。

**关键点**

• 自动化流水线：规则过滤（长度、重复率）加模型打分（质量分类器）。
• 去重与多样性：MinHash、聚类保证数据多样性。
• 主动学习：选择信息量大的样本进行标注。
• 分布式处理：使用Spark等工具并行处理。
• 质量监控：定期人工评估和指标监控。

**常见追问**

• 如何设计数据质量分类器？
• 去重算法有哪些？
• 主动学习如何与标注结合？

**易错点**

• 过度依赖自动化导致噪声积累。
• 忽略数据多样性，导致模型偏见。
• 流水线扩展时未考虑计算资源瓶颈。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## SFT

### 如果模型微调后通用能力下降怎么办？除了数据配比方面，还有什么办法？

**30 秒回答**

可采用参数高效微调（如LoRA）减少对通用能力的破坏；引入正则化（如KL散度约束输出分布）；进行模型融合（如权重插值）；使用课程学习或渐进式微调；在微调后通过通用数据回放或知识蒸馏恢复能力。

**关键点**

• 参数高效微调：仅更新部分参数，保留通用知识。
• 正则化约束：如KL散度限制微调模型与原始模型的输出差异。
• 模型融合：将微调模型与原始模型权重插值，平衡通用与专用能力。
• 课程学习：先通用后专用，或混合训练。
• 数据回放：在微调数据中混入通用数据（虽涉及数据但非配比）。
• 知识蒸馏：用原始模型指导微调模型。

**常见追问**

• LoRA微调时如何选择秩和模块？
• KL散度正则化的具体实现方式？
• 模型融合有哪些常见方法？

**易错点**

• 只关注数据配比，忽略其他技术手段。
• 正则化系数设置不当可能导致欠拟合。
• 模型融合可能不适用于所有架构。

**来源**

• 京东：[感谢东子收留，大模型算法实习面经](https://www.xiaohongshu.com/explore/6a571fa7000000001102c5fd?xsec_token=ABnaj5ITgbRk0kpUG7M3OyiNpF_TuoH3TaZk2VpWZmcIg=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 如何判断SFT数据量是否足够？通过哪些指标判断可以进入RL阶段？

**30 秒回答**

判断SFT数据量足够可看验证集损失是否收敛、生成质量是否稳定；进入RL阶段需SFT模型在目标任务上达到一定基线（如reward模型评分），且RL能带来提升（如通过小规模实验验证）。

**关键点**

• SFT数据量足够的标志：验证损失不再下降，生成质量稳定。
• 任务性能指标：在目标任务上达到预期基线（如准确率、BLEU）。
• RL阶段前提：SFT模型能生成多样且合理的输出，reward模型能区分好坏。
• 通过小规模RL实验验证是否有提升空间。
• 监控过拟合：若SFT数据过多导致过拟合，则需早停或增加数据。

**常见追问**

• 如何设计reward模型？
• SFT阶段过拟合有哪些表现？
• RL训练不稳定的原因有哪些？

**易错点**

• 仅凭数据量大小判断，忽略质量。
• 未验证reward模型可靠性就进入RL。
• 忽略SFT模型的基础能力，导致RL难以优化。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 数据构造中数据配比为什么要这么做？比例有什么讲究？如何验证CoT构造有效？CoT太长怎么办？

**30 秒回答**

数据配比需根据任务分布和模型能力调整，通常通过消融实验确定最优比例。验证CoT有效性需设计对照实验，评估下游任务指标和人工评估。CoT过长可精简步骤、提取关键推理或使用蒸馏压缩。

**关键点**

• 数据配比基于任务重要性、数据质量和模型薄弱环节，通过小规模消融实验确定比例。
• CoT有效性验证：对比有无CoT的模型在测试集上的表现，结合人工评估推理合理性。
• CoT过长影响推理效率和成本，可精简冗余步骤、提取关键推理链或训练小模型蒸馏。
• 权威认证非必需，但可参考公开研究（如CoT原论文）和领域最佳实践。

**常见追问**

• 如何设计消融实验确定数据配比？
• CoT蒸馏的具体方法有哪些？

**易错点**

• 避免声称有权威认证，应强调实验验证。
• CoT缩短可能损失推理完整性，需权衡效果与效率。

**来源**

• 京东：[感谢东子收留，大模型算法实习面经](https://www.xiaohongshu.com/explore/6a571fa7000000001102c5fd?xsec_token=ABnaj5ITgbRk0kpUG7M3OyiNpF_TuoH3TaZk2VpWZmcIg=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## RL后训练

### 从loss角度看，GRPO的设计有什么问题？

**30 秒回答**

GRPO的loss基于组内相对优势，但存在方差高、样本效率低的问题；其重要性采样比率可能不稳定，且对超参数敏感。此外，GRPO未显式约束策略更新幅度，可能导致训练崩溃。

**关键点**

• 组内相对优势估计方差大，尤其当组内奖励差异小时。
• 重要性采样比率可能爆炸或消失，导致梯度不稳定。
• 缺乏显式KL约束，策略可能偏离初始模型。
• 对组大小和奖励缩放敏感，需精细调参。
• 样本效率低，每个提示需多次采样。

**常见追问**

• 如何降低GRPO的方差？
• GRPO与PPO的loss有何异同？
• 如何稳定GRPO训练？

**易错点**

• 误认为GRPO无需critic就无偏
• 忽略组内归一化的影响
• 未考虑奖励尺度问题

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

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

### 多轮工具调用的RL loss如何设计？

**30 秒回答**

多轮工具调用的RL loss通常基于策略梯度，将整个多轮轨迹的累积奖励作为优化目标。需处理稀疏奖励、信用分配问题，常用方法包括轨迹级奖励回传、每轮奖励折扣、以及使用PPO等算法稳定训练。

**关键点**

• 轨迹级奖励：整个对话结束后给最终奖励
• 每轮奖励：对每个工具调用结果设计中间奖励
• 折扣因子平衡短期与长期收益
• 使用PPO/GRPO等算法优化策略
• 需处理动作空间包含工具调用和文本生成

**常见追问**

• 如何设计工具调用的奖励函数？
• 多轮场景下如何做信用分配？
• RL训练中如何避免工具调用崩溃？

**易错点**

• 忽略工具调用动作与文本动作的联合优化
• 奖励设计过于稀疏导致训练困难

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 多轮工具调用中，loss是每轮模型调用后计算，还是整个rollout完成后计算？

**30 秒回答**

通常在整个rollout完成后计算loss。因为多轮交互的奖励往往依赖最终结果，需等轨迹完整后获得回报，再通过策略梯度回传。每轮计算loss会面临奖励稀疏和信用分配难题，且难以利用未来信息。

**关键点**

• 整条轨迹完成后获得最终奖励
• 使用轨迹级回报计算策略梯度
• 每轮计算需设计中间奖励，更复杂
• 整条轨迹计算更符合RL范式
• 可结合GAE进行优势估计

**常见追问**

• 如果每轮都有明确奖励，可以每轮计算吗？
• 整条轨迹计算时如何做信用分配？
• 在线与离线RL在loss计算上的区别？

**易错点**

• 误以为必须每轮计算loss
• 忽略轨迹长度对内存的影响

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 奖励函数基于规则匹配，主观类问题如何判断好坏？用LLM as Judge时从哪几个维度评估？

**30 秒回答**

主观问题可用LLM as Judge，从相关性、流畅性、一致性、安全性、信息量等维度评估。需设计详细评分标准，并校准Judge与人类的一致性。规则匹配可结合语义相似度等软指标。

**关键点**

• 主观评估维度：相关性、流畅性、逻辑一致性、安全性、信息丰富度。
• LLM as Judge需提供清晰评分准则（如1-5分），并做人工校准。
• 规则匹配可扩展为规则+模型混合，如用BERT计算语义相似度。
• 注意Judge的偏见（位置、长度），可多Judge投票或交换顺序。

**常见追问**

• 如何校准LLM Judge？
• 主观评估中如何保证公平性？

**易错点**

• LLM Judge可能偏好长答案或特定风格。
• 主观维度需任务定制，不能一概而论。

**来源**

• 京东：[感谢东子收留，大模型算法实习面经](https://www.xiaohongshu.com/explore/6a571fa7000000001102c5fd?xsec_token=ABnaj5ITgbRk0kpUG7M3OyiNpF_TuoH3TaZk2VpWZmcIg=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 介绍DPO的流程和损失函数细节。DPO训练后choosen和reject的概率都提升了，可能吗？怎么办？假设数据集干净，从数学角度回答。

**30 秒回答**

DPO直接优化策略，损失函数为-logσ(β log π(yw|x)/πref(yw|x) - β log π(yl|x)/πref(yl|x))。可能两者概率都提升，因DPO优化相对概率，若β过大或数据分布偏移，绝对概率可能上升。可调整β、检查数据或引入正则。

**关键点**

• DPO流程：用偏好数据对（chosen, rejected）训练，损失函数基于Bradley-Terry模型。
• 损失函数：L = -E[log σ(β log π(yw|x)/πref(yw|x) - β log π(yl|x)/πref(yl|x))]。
• 两者概率都提升：数学上可能，因DPO只约束相对差，若β小或参考模型偏差，绝对概率可同升。
• 解决方法：增大β、检查数据质量、加入KL正则或使用IPO等变体。

**常见追问**

• DPO与PPO的优劣比较？
• β参数如何影响训练？

**易错点**

• DPO假设偏好数据干净，但实际可能有噪声。
• 概率同升不一定表示训练失败，需看相对差。

**来源**

• 京东：[感谢东子收留，大模型算法实习面经](https://www.xiaohongshu.com/explore/6a571fa7000000001102c5fd?xsec_token=ABnaj5ITgbRk0kpUG7M3OyiNpF_TuoH3TaZk2VpWZmcIg=&xsec_source=pc_search)

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

### 如果让你设计Agent的Reward，你会从哪些维度去设计？怎么避免Reward Hacking？

**30 秒回答**

设计维度：1) 任务完成度：最终目标是否达成；2) 效率：步数、时间、token消耗；3) 安全性：合规、无有害操作；4) 鲁棒性：异常处理与恢复能力；5) 用户体验：交互自然度、解释性。避免Reward Hacking：多维度加权并定期评估权重；引入对抗测试和红队；使用人类反馈持续校准；设置奖励上限和惩罚项；监控异常行为并动态调整；采用过程奖励与最终奖励结合。

**关键点**

• 任务完成度：核心指标，确保最终目标达成
• 效率与资源消耗：步数、时间、token数等约束
• 安全与合规：避免有害、违规操作
• 鲁棒性与用户体验：异常处理、交互质量
• 防Hacking：多维度平衡、对抗测试、人类反馈、动态调整、过程奖励

**常见追问**

• 如何量化安全性和用户体验？
• 多目标奖励如何加权？权重如何确定？
• 如何设计对抗测试来发现Reward Hacking？

**易错点**

• 过度依赖单一奖励信号容易导致Hacking
• 权重设置不合理可能导致Agent行为偏差
• 忽略长期影响，只关注短期奖励

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 如果想让Reward Model最后只能输出一个分数，你会怎么设计模型和Loss？

**30 秒回答**

模型设计：在预训练语言模型（如BERT或LLM）后接一个线性头，输出标量分数；或使用池化后的表示接MLP。Loss设计：常用 pairwise ranking loss（如Bradley-Terry模型），对偏好对 (y_w, y_l) 计算 -log sigmoid(r(y_w)-r(y_l))；也可用回归loss拟合人工分数，或结合交叉熵。确保输出层为单神经元，无softmax。

**关键点**

• 模型结构：基座模型+标量输出头（线性层或MLP）
• Pairwise Ranking Loss：基于Bradley-Terry模型，最大化偏好对分数差
• 回归Loss：直接拟合人工标注的分数（MSE）
• 输出层设计：单神经元，无激活函数（或线性激活）
• 训练技巧：对分数做归一化、使用margin、数据增强

**常见追问**

• Bradley-Terry模型与Plackett-Luce模型有什么区别？
• 如何处理多个标注者之间的不一致？
• Reward Model训练中如何避免过拟合？

**易错点**

• 使用softmax输出多分类而非标量分数
• 损失函数未考虑偏好对的对称性
• 忽略分数尺度对后续RL训练的影响

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Agent任务最后只有一个Reward，中间这么多步，信用分配怎么做？

**30 秒回答**

常用方法包括：1) 蒙特卡洛回报：用最终奖励作为所有步骤的回报，简单但方差大；2) 时序差分与GAE：训练Critic估计每步价值，用TD误差或GAE计算优势，降低方差；3) 步骤级奖励建模：用过程奖励模型或规则给中间步骤打分；4) 逆强化学习或偏好学习推断步骤奖励；5) 分层RL：高层规划子目标，低层执行并获取内在奖励。实际中常结合GAE与过程奖励模型。

**关键点**

• 蒙特卡洛回报：最终奖励直接作为每步回报，实现简单但方差高
• Actor-Critic与GAE：Critic估计状态价值，用TD误差或GAE计算优势函数
• 过程奖励模型：训练PRM对中间步骤打分，提供稠密奖励
• 逆强化学习/偏好学习：从最终结果或人类偏好中推断步骤级奖励
• 分层强化学习：高层策略产生子目标，低层策略获得内在奖励

**常见追问**

• GAE中的λ参数如何影响偏差与方差？
• 过程奖励模型如何训练？需要什么数据？
• 在LLM Agent中，Critic如何设计？与语言模型共享参数吗？

**易错点**

• 只使用蒙特卡洛回报可能导致训练不稳定、收敛慢
• 过程奖励模型可能引入噪声或偏差，需要与最终奖励平衡
• 忽略折扣因子γ的设置对长序列信用分配的影响

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Agentic RL与普通单轮LLM RL有什么区别？

**30 秒回答**

Agentic RL面向多轮交互任务，状态包含环境历史，动作空间包括工具调用和文本生成，奖励稀疏且延迟；普通单轮LLM RL仅优化单轮生成，状态为提示，动作为整个回复，奖励基于生成质量。Agentic RL需处理长期信用分配和探索效率问题。

**关键点**

• 交互轮次：Agentic RL多轮，普通RL单轮。
• 状态表示：Agentic RL包含环境状态和历史；普通RL仅当前提示。
• 动作空间：Agentic RL包括工具调用、API请求等；普通RL为文本序列。
• 奖励设计：Agentic RL奖励稀疏、延迟；普通RL奖励即时（如奖励模型打分）。
• 训练挑战：Agentic RL需处理部分可观测、信用分配和样本效率。

**常见追问**

• 如何设计Agentic RL的奖励函数？
• 如何解决多轮信用分配问题？
• Agentic RL中如何平衡探索与利用？

**易错点**

• 忽略环境动态性
• 将多轮简单拆分为单轮
• 低估奖励稀疏性带来的训练困难

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

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

### DPO的基本原理是什么？损失函数如何构造？

**30 秒回答**

DPO直接优化策略模型，绕过奖励建模和RL。损失函数基于偏好数据，最大化偏好回答与不偏好回答的似然比差异，形式为-log sigmoid(β log π(y_w|x)/π_ref(y_w|x) - β log π(y_l|x)/π_ref(y_l|x))。

**关键点**

• DPO将RLHF目标转化为分类损失，无需显式奖励模型。
• 损失函数使用偏好对(y_w, y_l)和参考模型π_ref。
• β控制与参考模型的偏离程度。
• 训练稳定，计算高效。

**常见追问**

• DPO与PPO相比优缺点？
• β参数如何影响DPO训练？

**易错点**

• 误以为DPO需要训练奖励模型。
• 忽略参考模型的作用。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### GRPO中的优势消失是什么？为什么组内奖励方差为零时没有有效学习信号？

**30 秒回答**

GRPO中优势消失指组内奖励方差为零时，归一化优势变为0，策略梯度无更新信号。因为优势函数A=(r-mean)/std，当所有奖励相同，分子为0，分母为0或极小，导致优势为0或数值不稳定，无法区分动作好坏，学习停滞。

**关键点**

• GRPO通过组内奖励归一化计算优势，无需critic。
• 优势消失：组内奖励方差为零时，归一化优势为0。
• 无有效学习信号：策略梯度为0，参数不更新。
• 解决方法：奖励设计增加多样性、组大小调整、使用基线或熵正则。

**常见追问**

• 如何避免GRPO中的优势消失？
• 组大小对GRPO训练有什么影响？

**易错点**

• 误以为优势消失是梯度爆炸。
• 忽略分母为零的数值稳定性问题。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### GSPO相比GRPO做了什么改进？

**30 秒回答**

GSPO在GRPO基础上引入序列级重要性采样和裁剪，将优势估计从token级扩展到序列级，并采用更稳定的策略优化目标，减少方差和训练不稳定性，同时提升样本效率。

**关键点**

• 序列级重要性采样：考虑整个序列的概率比，而非逐token。
• 序列级裁剪：约束策略更新幅度，避免崩溃。
• 优势估计：使用序列级回报，减少方差。
• 训练稳定性：更平滑的优化目标，对超参数更鲁棒。
• 样本效率：通过更好的信用分配提升。

**常见追问**

• GSPO的序列级裁剪如何实现？
• GSPO与PPO的序列级优化有何区别？
• GSPO在哪些任务上表现更好？

**易错点**

• 混淆token级与序列级优化
• 忽略裁剪机制的作用
• 误认为GSPO完全解决方差问题

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### OPD、SFT、GRPO分别适合什么场景？你会怎么选？

**30 秒回答**

SFT适合有标注数据的监督学习，快速对齐格式和基础能力；GRPO是强化学习算法，适合有奖励信号的优化，如数学推理和代码生成；OPD（On-Policy Distillation）适合用强模型指导弱模型，在线蒸馏提升效果。选择取决于数据、奖励和计算资源：有标注用SFT，有奖励用GRPO，有强教师用OPD。

**关键点**

• SFT：监督微调，需标注数据，适合基础能力对齐
• GRPO：群体相对策略优化，需奖励函数，适合推理任务
• OPD：在线策略蒸馏，用强模型指导，适合提升小模型
• 选择依据：数据标注、奖励信号、教师模型可用性
• 可组合使用：SFT预热后GRPO优化

**常见追问**

• GRPO相比PPO有什么优势？
• OPD中如何设计蒸馏损失？
• SFT数据质量如何影响后续RL？

**易错点**

• 混淆OPD和离线蒸馏，OPD是在线策略
• GRPO需要设计合适的奖励函数，否则效果差
• SFT数据不足时直接RL容易崩溃

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### PPO 和 GRPO 有什么区别？

**30 秒回答**

PPO 使用价值网络估计优势，需训练 critic 模型；GRPO 去掉 critic，用组内归一化奖励作为优势估计，降低内存和计算开销。GRPO 更适合大模型 RL 微调，尤其当奖励稀疏时，通过组内比较提供相对优势。

**关键点**

• PPO 需要 actor 和 critic 两个模型，训练成本高。
• GRPO 对同一 prompt 采样多个输出，组内归一化计算优势。
• GRPO 无需价值网络，节省显存，适合大模型。
• GRPO 在数学推理等任务上表现良好，但依赖组采样质量。

**常见追问**

• GRPO 中组大小如何影响训练效果？
• GRPO 相比 PPO 有哪些局限性？

**易错点**

• 误以为 GRPO 完全不需要奖励模型。
• 忽略组内归一化对优势估计的偏差影响。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### PPO和GRPO的本质区别是什么？

**30 秒回答**

PPO使用critic网络估计状态价值计算优势，需训练价值模型；GRPO摒弃critic，直接对同一prompt下的一组采样奖励归一化得到优势，减少内存和计算开销，更适配大模型RLHF。

**关键点**

• PPO：actor-critic架构，需训练价值网络估计优势。
• GRPO：无critic，组内奖励归一化作为优势。
• GRPO降低显存和计算成本，适合大模型。
• 两者都使用重要性采样和裁剪目标。

**常见追问**

• GRPO为什么能去掉critic？
• GRPO的组内归一化如何实现？

**易错点**

• 误以为GRPO完全不需要基线。
• 混淆GRPO与DPO。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Process Reward和Outcome Reward有什么区别？长程Agent更适合哪种？

**30 秒回答**

Process Reward对推理每一步给予奖励，提供密集信号，但需要步级标注；Outcome Reward只对最终结果奖励，稀疏但易获取。长程Agent因步骤多、信用分配难，更适合Process Reward，能缓解稀疏奖励和错误累积，但需设计步级奖励函数或使用自动标注。

**关键点**

• Process Reward：步级奖励，密集信号，需步级标注
• Outcome Reward：最终结果奖励，稀疏信号，易获取
• 长程Agent步骤多，信用分配困难，适合Process Reward
• Process Reward可缓解稀疏奖励和错误累积
• 可结合两者：Outcome为主，Process为辅

**常见追问**

• 如何自动生成步级奖励标注？
• Process Reward会不会导致短视行为？
• 长程Agent中如何平衡两种奖励？

**易错点**

• 认为Process Reward总是更好，忽略标注成本
• Outcome Reward在长程任务中信号稀疏，难以学习
• 步级奖励设计不当可能引入偏差

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Reward Model和LLM-as-Judge有什么区别？分别适合什么场景？

**30 秒回答**

Reward Model是专门训练的标量打分模型，通常基于偏好数据训练，输出单一分数，适合RLHF中的奖励信号，需大量标注且泛化有限。LLM-as-Judge直接使用大模型进行 pairwise 或打分评估，无需额外训练，灵活但可能有偏差和成本高。RM适合训练阶段提供密集奖励，Judge适合评估和离线筛选。

**关键点**

• Reward Model：专门训练，输出标量分数，用于RLHF奖励
• LLM-as-Judge：直接用LLM评估，支持pairwise或打分，无需训练
• RM需要偏好标注数据，Judge依赖LLM自身能力
• RM适合训练时提供奖励信号，Judge适合评估和筛选
• Judge可能存在位置偏差、长度偏差，需设计prompt缓解

**常见追问**

• 如何缓解LLM-as-Judge的偏差？
• Reward Model训练时如何避免过拟合？
• 能否用LLM-as-Judge替代Reward Model做RLHF？

**易错点**

• 混淆RM和Judge的用途，RM用于训练奖励，Judge用于评估
• 认为Judge完全免费，实际推理成本高
• 忽略RM的泛化能力限制，在分布外数据上失效

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

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

### SFT、DPO 和 RL 有什么区别？

**30 秒回答**

SFT 是有监督微调，用标注数据直接训练模型模仿目标输出；DPO 直接优化偏好数据，绕过奖励模型和 RL 循环；RL（如 PPO）通过奖励模型和策略梯度优化，需在线采样。SFT 是基础，DPO 更稳定高效，RL 更灵活但复杂。

**关键点**

• SFT 使用交叉熵损失，依赖高质量标注数据。
• DPO 将偏好损失转化为分类问题，无需显式奖励模型。
• RL 需要奖励模型和在线采样，训练不稳定但可探索新策略。
• 实际中常先 SFT 再 DPO 或 RL，以对齐人类偏好。

**常见追问**

• DPO 的损失函数如何推导？
• 为什么 RL 训练容易不稳定？如何缓解？

**易错点**

• 认为 DPO 完全不需要偏好数据。
• 混淆 RL 中的奖励模型和策略模型。

**来源**

• 阿里巴巴：[阿里大模型算法面经（已经offer）](https://www.xiaohongshu.com/explore/6ab0fac2000000003602a36d?xsec_token=AB751HEfUib5oHj9dFGQj0qSAzv1EjuhgaMBL9WrOpACk=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### SFT效果如何评估？为什么还要做GRPO？GRPO奖励函数如何设计？为什么不直接SFT做到底？

**30 秒回答**

SFT评估用测试集准确率、BLEU/ROUGE、人工评估等。GRPO通过强化学习优化奖励，能探索更优策略，超越SFT的模仿学习。奖励函数设计需结合任务目标，如正确性、流畅性。SFT受限于数据质量，难以优化长期奖励。

**关键点**

• SFT评估：自动指标（准确率、F1、BLEU）和人工评估（流畅性、相关性）。
• GRPO优势：通过奖励信号优化生成策略，鼓励探索，避免SFT的曝光偏差。
• 奖励函数设计：任务相关（如答案正确性、格式合规）、可量化、避免奖励黑客。
• SFT局限：仅模仿数据分布，无法优化非可微指标；GRPO可针对最终目标优化。

**常见追问**

• GRPO与PPO的区别？
• 如何避免奖励函数被黑客利用？

**易错点**

• GRPO训练不稳定，需调参和奖励裁剪。
• SFT并非无用，常作为RL的初始化。

**来源**

• 京东：[感谢东子收留，大模型算法实习面经](https://www.xiaohongshu.com/explore/6a571fa7000000001102c5fd?xsec_token=ABnaj5ITgbRk0kpUG7M3OyiNpF_TuoH3TaZk2VpWZmcIg=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

## Agent

### 成功判定是否要求模型必须选中最符合要求的那个商品？

**30 秒回答**

成功判定通常要求模型选中最符合要求的商品，但也可放宽为满足用户核心需求。严格判定提高准确性要求，宽松判定更贴近实际。需明确判定标准，并考虑多解情况。

**关键点**

• 严格判定：必须选中最优商品。
• 宽松判定：满足用户主要约束即可。
• 判定标准影响评估指标和训练信号。
• 多解时需定义等价成功条件。

**常见追问**

• 如何定义“最符合要求”？
• 如果用户需求模糊，如何判定成功？

**易错点**

• 未明确成功判定的具体标准。
• 忽略多解情况导致误判。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

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

### 你提到的结构化处理具体是什么意思？环境原始返回的是类似网页的内容吗？

**30 秒回答**

结构化处理指将环境返回的非结构化数据（如 HTML 网页、自然语言文本）解析为 JSON 等结构化格式，提取关键字段（如商品名、价格），便于 Agent 理解与决策。原始返回可能是网页内容，需清洗和解析。

**关键点**

• 原始返回可能为 HTML、文本等非结构化数据。
• 结构化处理包括解析、提取关键信息、转换为 JSON 等。
• 目的：降低 Agent 理解难度，提高决策准确性。
• 常用工具：BeautifulSoup、正则表达式、LLM 提取。

**常见追问**

• 你用什么方法做结构化处理？
• 如何处理解析错误或缺失字段？

**易错点**

• 将结构化处理简单等同于数据清洗。
• 未考虑解析的鲁棒性。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 如果一个Agent最终答错了，你怎么判断到底是哪一步出了问题？

**30 秒回答**

通过分步日志和中间结果定位：检查每步的输入输出、工具调用结果、推理链是否合理。可人工审查或自动化评估每步正确性，对比预期轨迹。常见问题包括工具调用错误、推理逻辑断裂、信息检索失败。使用过程奖励模型或LLM-as-Judge对每步打分，定位最早出错步骤。

**关键点**

• 记录完整轨迹：每步的输入、输出、工具调用和结果
• 分步评估：人工或自动检查每步正确性，定位最早错误
• 常见错误类型：工具调用参数错误、推理逻辑错误、信息缺失
• 使用过程奖励模型（PRM）对每步打分
• 对比成功轨迹，分析差异点

**常见追问**

• 如何自动化定位错误步骤？
• 过程奖励模型如何训练？
• 如何设计Agent的容错机制？

**易错点**

• 只关注最终结果，忽略中间步骤
• 错误可能累积，需找到最早出错点
• 工具调用错误可能被后续步骤掩盖

**来源**

• 京东：[京东大模型算法面经（已速通，不看会后悔～）](https://www.xiaohongshu.com/explore/6a92bd8a0000000025011e8d?xsec_token=ABxpZLR34VAu24fuE7ufYXQH9kxMuQNf2UaegiE_Snlrc=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 如果最多执行35步，只看了前5个商品，但目标商品排在第10个，怎么办？

**30 秒回答**

需优化策略：优先使用筛选/排序功能缩小范围，或直接跳页；记录已查看商品避免重复；若步数不足，可提前终止并基于已有信息决策，或调整步数限制。核心是平衡探索与利用。

**关键点**

• 利用筛选和排序快速定位目标
• 跳页功能减少浏览步骤
• 记录已查看商品，避免重复
• 步数不足时基于部分信息决策或调整限制

**常见追问**

• 如何设计步数分配策略？
• 是否应优先查看高排名商品？

**易错点**

• 盲目顺序浏览导致步数耗尽
• 忽略筛选工具的使用

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

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

### 是否需要逐个进入商品详情页查看，再返回搜索页面继续比较？

**30 秒回答**

是的，通常需要逐个进入详情页查看关键信息（如价格、规格、评价），然后返回搜索结果页继续比较其他商品。这是为了获取列表页缺失的细节，确保比较的全面性和准确性。但可通过多标签页或记录工具优化流程。

**关键点**

• 详情页提供列表页缺失的详细信息
• 返回搜索页是为了继续浏览其他候选商品
• 逐个查看确保信息准确，避免遗漏
• 可优化：使用多标签页或并行打开减少往返

**常见追问**

• 如何设计Agent减少页面跳转？
• 是否可以用爬虫技术批量获取？

**易错点**

• 认为可以跳过详情页直接比较
• 忽略返回搜索页的必要性

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 搜索结果是如何排序的？排序会不会影响最终结果？

**30 秒回答**

搜索结果通常按相关性、销量、价格、评价等综合排序，可能包含广告。排序会影响Agent的浏览顺序和效率，若目标商品排名靠后，需更多步骤翻页查找，但通过系统化遍历可减少影响。

**关键点**

• 排序依据：相关性、销量、价格、评价、广告等
• 排序影响浏览顺序和步骤数
• 目标商品靠后时需翻页或筛选
• Agent应设计策略应对排序偏差（如按条件筛选）

**常见追问**

• 如何让Agent自适应排序变化？
• 排序算法是否可被利用？

**易错点**

• 认为排序不影响结果
• 忽略广告位对排序的干扰

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 为什么这个任务需要长达35步？能否直接从搜索结果中提取符合要求的商品？

**30 秒回答**

任务需要35步是因为Agent需模拟人类比价流程：搜索、翻页、点进详情页查看规格/评价、返回列表、记录信息、多轮比较。不能直接从搜索结果提取，因为列表页信息有限（如价格、促销、规格不全），且需验证商品详情，确保准确性。

**关键点**

• 列表页信息有限，缺少关键属性（如详细规格、用户评价、库存）
• 需进入详情页获取完整信息并验证
• 多商品比较需要记录和回溯，步骤自然增多
• 直接提取可能遗漏隐藏信息或导致错误决策

**常见追问**

• 如何优化步骤数量？
• 能否用并行操作减少步数？

**易错点**

• 认为列表页包含所有必要信息
• 忽略详情页验证的重要性

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 在 Agent 系统中，如何区分长记忆和短记忆？

**30 秒回答**

短记忆是当前会话的上下文（如对话历史），容量有限、临时存储；长记忆是跨会话持久化的信息（如用户偏好、知识库），需外部存储和检索。区分依据是生命周期和访问范围，短记忆随会话结束失效，长记忆需显式管理。

**关键点**

• 短记忆：当前对话的 token 序列，受上下文窗口限制，通常不持久化。
• 长记忆：跨会话存储，可能包括用户画像、历史交互摘要、领域知识。
• 长记忆需要设计存储结构（向量库、数据库）和检索机制。
• 短记忆管理策略：滑动窗口、摘要压缩、关键信息提取。
• 长记忆更新策略：重要性评分、遗忘机制、冲突消解。

**常见追问**

• 如何设计长记忆的存储和检索方案？
• 短记忆压缩有哪些常见方法？
• 如何评估长记忆对 Agent 性能的影响？

**易错点**

• 将长记忆简单等同于向量数据库，忽略结构化信息。
• 未考虑记忆冲突和更新，导致信息过时。

**来源**

• OPPO：[OPPO Agent 算法日常（一面）](https://www.xiaohongshu.com/explore/6a1d9047000000000603089e?xsec_token=ABzM_KlXsBMl-j2-gsac4fifh05dRLzAzvQgZeBqnrRco=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 在 Agent 项目中，工具是环境自带的还是你自己设计的？

**30 秒回答**

工具来源取决于项目设定：若基于现有环境（如购物网站），工具通常是环境提供的 API；若自建环境，则需自行设计工具接口。面试中应说明工具来源、设计理由及对 Agent 行为的影响。

**关键点**

• 明确工具来源：环境自带（如模拟器 API）或自行设计（自定义函数）。
• 自行设计时需考虑工具粒度、输入输出格式、错误处理。
• 工具设计影响 Agent 的规划与执行能力。
• 可举例说明工具如何支持任务完成。

**常见追问**

• 你如何设计工具的描述（description）来引导模型正确调用？
• 工具调用失败时 Agent 如何恢复？

**易错点**

• 混淆环境工具与自建工具，回答模糊。
• 未说明工具设计对 Agent 性能的影响。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 在有限 token 资源和紧张项目进度下，如何最大化开发效率并降低长耗时 Debug 的 API 成本？

**30 秒回答**

将 AI 协作类比为多人开发：通过可沉淀的 skills 快速定位模块，建立上下文丢失后的恢复机制；将项目沉淀为 Wiki/Spec/长短期记忆；多窗口协作时保证模块解耦，减少重复上下文传递，从而降低 token 消耗和调试成本。

**关键点**

• 模块化设计：清晰接口和文档，便于 AI 理解局部代码。
• 建立项目知识库（Wiki/Spec），减少重复解释。
• 使用长短期记忆管理对话上下文，避免每次从头开始。
• 多窗口协作时确保任务解耦，独立上下文。
• 设置调试检查点，快速恢复而非重新生成。

**常见追问**

• 如何设计可沉淀的 skills 来提升 AI 协作效率？
• 在多窗口协作中，如何保证上下文一致性？
• 有哪些工具可以管理长短期记忆和项目知识？

**易错点**

• 将所有代码放在一个上下文中，导致 token 爆炸。
• 缺乏文档，每次调试都需重新解释项目结构。

**来源**

• OPPO：[OPPO Agent 算法日常（一面）](https://www.xiaohongshu.com/explore/6a1d9047000000000603089e?xsec_token=ABzM_KlXsBMl-j2-gsac4fifh05dRLzAzvQgZeBqnrRco=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 这个 Simulator 是专门为购物场景设计的吗？

**30 秒回答**

Simulator 的设计目的需结合项目背景回答。若项目为购物 Agent，则模拟器可能专为购物场景定制，包含商品搜索、比价、下单等交互；也可基于通用模拟器（如 WebShop）适配。应说明模拟器的场景特化程度及可扩展性。

**关键点**

• 明确模拟器是否针对购物场景定制。
• 定制模拟器可包含领域特定状态和动作。
• 通用模拟器需适配购物任务。
• 场景特化影响 Agent 训练与评估的真实性。

**常见追问**

• 模拟器如何模拟真实购物环境？
• 如何保证模拟器与真实场景的一致性？

**易错点**

• 未区分定制模拟器与通用模拟器。
• 忽略模拟器与真实环境的差距。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### 中间过程的奖励具体是怎么设计的？

**30 秒回答**

中间过程奖励设计需引导 Agent 逐步完成任务。常见方法：对关键步骤（如正确搜索、筛选）给予正奖励；对错误动作（如无效点击）给予负奖励；也可用 LLM 对中间状态打分。设计时需平衡奖励密度与稀疏性，避免误导。

**关键点**

• 步骤级奖励：正确动作给正分，错误动作给负分。
• 状态级奖励：评估中间状态与目标的接近程度。
• LLM 打分：利用大模型评估中间结果质量。
• 奖励塑形（reward shaping）需保持策略不变性。

**常见追问**

• 如何设计奖励函数避免 Agent 走捷径？
• 中间奖励与最终奖励如何加权？

**易错点**

• 中间奖励设计不当导致 Agent 行为异常。
• 奖励过于稀疏或密集。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Agent的评估与普通LLM评估有什么区别？

**30 秒回答**

Agent评估需在多轮交互环境中进行，关注任务完成率、工具调用正确性、规划与反思能力，而普通LLM评估主要针对单轮生成质量（如BLEU、ROUGE、准确率）。Agent评估更复杂，需模拟环境、定义成功标准，并考虑长期依赖和错误传播。

**关键点**

• 评估维度：Agent关注任务成功率、工具使用、规划、鲁棒性；LLM关注生成质量、事实性、流畅性。
• 评估方式：Agent需交互式环境（如WebArena）和轨迹评估；LLM常用静态数据集和自动指标。
• 成功标准：Agent需定义多步任务完成条件；LLM通常有参考答案。
• 错误传播：Agent多轮中错误会累积，评估需考虑中间步骤。
• 成本：Agent评估需实际执行动作，成本高；LLM评估可离线批量。

**常见追问**

• 如何设计Agent评估的奖励函数？
• 有哪些常用的Agent评估基准？
• 如何评估Agent的规划能力？

**易错点**

• 混淆单轮与多轮评估指标
• 忽略环境交互的复杂性
• 未考虑工具调用的正确性评估

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Embedder 和 Reranker 有什么区别？

**30 秒回答**

Embedder 将文本映射为向量，用于粗筛（如双塔模型），计算高效但精度较低；Reranker 对候选文档精细打分（如交叉编码器），精度高但计算量大。通常先 Embedder 召回 Top-K，再用 Reranker 精排。

**关键点**

• Embedder 是双塔结构，独立编码 query 和 doc，可离线建索引，适合大规模召回。
• Reranker 是交叉编码器，联合编码 query-doc 对，捕捉细粒度交互，精度更高。
• Embedder 输出向量相似度，Reranker 输出相关性分数。
• 典型流程：Embedder 召回 Top-100，Reranker 精排 Top-10。
• Reranker 计算成本高，通常只用于少量候选。

**常见追问**

• 双塔模型和交叉编码器在训练目标上有什么不同？
• 如何评估 Embedder 和 Reranker 的效果？
• 在 Agent 场景中，Embedder 和 Reranker 分别用在哪些环节？

**易错点**

• 混淆两者用途，误以为 Reranker 可用于大规模召回。
• 忽略 Reranker 的延迟问题，在实时系统中直接对全量文档排序。

**来源**

• OPPO：[OPPO Agent 算法日常（一面）](https://www.xiaohongshu.com/explore/6a1d9047000000000603089e?xsec_token=ABzM_KlXsBMl-j2-gsac4fifh05dRLzAzvQgZeBqnrRco=&xsec_source=pc_search)

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

### ReAct的原理和工作方式是什么？

**30 秒回答**

ReAct将推理与行动结合，模型交替生成思考（Reason）和行动（Act），行动调用工具获取观察结果，再基于观察继续推理。通过多轮循环，模型能动态利用外部信息，提升复杂任务的表现和可解释性。

**关键点**

• Reason：生成自然语言推理轨迹
• Act：调用工具执行动作
• Observation：获取工具返回结果
• 循环迭代直至任务完成
• 结合思维链与工具使用

**常见追问**

• ReAct与思维链（CoT）的区别？
• 如何设计ReAct的提示词？
• ReAct的局限性是什么？

**易错点**

• 混淆ReAct与纯CoT，忽略工具调用
• 未考虑行动失败时的回退策略

**来源**

• 腾讯：[腾讯大模型算法面经（已经offer，压力爆大版）](https://www.xiaohongshu.com/explore/6ab4e95b000000000b007a45?xsec_token=ABVKzHYRXtEibKslhdti0s_l81EMK4OCWesZfVNwG6jzI=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Reward 具体是如何打分的？

**30 秒回答**

Reward 打分通常基于任务成功与否及中间步骤质量。成功判定可依据是否选中最符合要求的商品；中间奖励可设计为步骤正确性、信息完整性等。常用方法包括规则打分、模型打分或混合方式，需平衡稀疏与密集奖励。

**关键点**

• 成功奖励：任务完成（如选对商品）给高分。
• 中间奖励：步骤正确、信息收集等给部分分。
• 规则打分：基于预定义条件；模型打分：用 LLM 评估。
• 奖励设计影响 Agent 学习效率和最终性能。

**常见追问**

• 如何避免奖励黑客（reward hacking）？
• 稀疏奖励下如何训练 Agent？

**易错点**

• 只关注最终奖励，忽略中间过程。
• 奖励设计过于复杂导致难以优化。

**来源**

• 商汤：[商汤一面面经](https://www.xiaohongshu.com/explore/6aba6ea40000000015003135?xsec_token=ABNk4iuQfF7GduyqHICWIOrIblmJQCXAh5UNBqChmKEv0=&xsec_source=pc_search)

> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。

### Vibe coding 陷入死循环时如何进行干预？

**30 秒回答**

干预方式包括：1）人工审查代码和错误信息，定位循环原因；2）重置对话上下文，提供更明确的指令；3）拆解任务，分步验证；4）引入外部工具（如调试器、日志）打破循环；5）设置最大迭代次数，超限后切换策略。

**关键点**

• 分析循环模式：是模型重复生成相同错误，还是任务定义不清。
• 提供更具体的约束和示例，减少歧义。
• 将大任务拆分为小步骤，每步验证通过后再继续。
• 使用外部反馈（测试结果、日志）引导模型修正。
• 设置迭代上限，避免无限消耗 token。

**常见追问**

• 如何设计 prompt 减少死循环的发生？
• 在团队协作中，如何建立死循环的预警机制？
• 有哪些工具可以辅助检测代码生成中的循环？

**易错点**

• 盲目让模型继续尝试，不提供新信息。
• 忽略任务拆解，试图一次性生成复杂代码。

**来源**

• OPPO：[OPPO Agent 算法日常（一面）](https://www.xiaohongshu.com/explore/6a1d9047000000000603089e?xsec_token=ABzM_KlXsBMl-j2-gsac4fifh05dRLzAzvQgZeBqnrRco=&xsec_source=pc_search)

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
