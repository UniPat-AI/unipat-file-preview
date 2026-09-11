"""所有处理器都在 :mod:`converter.processors` 内。

每个模块导出 ``process`` 或者若干具名 ``process_*`` 函数，签名统一为
``(ctx: ProcessorContext) -> Manifest``。
"""
