class UpstreamError(RuntimeError):
    """AKShare 调用失败或网络不可用。"""


class UpstreamSchemaError(RuntimeError):
    """上游返回的列名/数据类型与约定不符，不能静默当成空数据。"""
