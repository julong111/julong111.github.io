+++
title = "文章标题"
date = 2024-12-05
updated = 2024-12-06
slug = "from-0-to-1-the-blog-review"
# 是否是草稿
draft = true
description = ""

# 对照 data.toml 的内容
[taxonomies]
tags = ["blog", "featured","hot"]
categories = ["misc"]

[extra]
# 当前目录下的封面
cover = "cover.webp"
# content下全局路径封面（封面存放的目录需要有被渲染的md文件，否则封面所在文件夹在渲染时不会保留）
# 注意，由于 zola 框架尚未支持 avif 格式转换，请勿在 global_cover 中使用 avif 格式的图片，否则会报错
global_cover  = "/articles/misc/path/to/cover.webp"
# 微信公众号链接
wechat_url = "https://mp.weixin.qq.com/s/xxx"
# 是否在正文提示文章更新时间过久，内容可能过时
update_tip_enable = true
# 转载链接
repost_url = ""
# 版权协议链接 默认 /copyright
copyright_url = ""
+++