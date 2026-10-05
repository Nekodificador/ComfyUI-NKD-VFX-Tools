"""
3D Attention Mechanism for Multi-View Diffusion (MVDream-style)

This module implements 3D attention by extending diffusers' attention blocks
to handle multiple views/frames through tensor reshaping.
"""

from typing import Optional, Dict, Any
import torch
import torch.nn as nn
from einops import rearrange
from diffusers.models.attention import BasicTransformerBlock


class BasicTransformerBlock3D(BasicTransformerBlock):
    """
    A 3D-aware transformer block that extends diffusers' BasicTransformerBlock.

    Instead of modifying the attention mechanism itself, this block reshapes
    tensors to concatenate multiple views/frames in the sequence dimension,
    allowing standard attention to capture cross-view dependencies.

    The reshaping pattern is:
    - Before attention: (batch * num_frames, seq_len, channels) -> (batch, num_frames * seq_len, channels)
    - After attention: (batch, num_frames * seq_len, channels) -> (batch * num_frames, seq_len, channels)

    This enables each position to attend across all views simultaneously.
    """

    def __init__(
        self,
        dim: int,
        num_attention_heads: int,
        attention_head_dim: int,
        dropout: float = 0.0,
        cross_attention_dim: Optional[int] = None,
        activation_fn: str = "geglu",
        num_embeds_ada_norm: Optional[int] = None,
        attention_bias: bool = False,
        only_cross_attention: bool = False,
        double_self_attention: bool = False,
        upcast_attention: bool = False,
        norm_elementwise_affine: bool = True,
        norm_type: str = "layer_norm",
        norm_eps: float = 1e-5,
        final_dropout: bool = False,
        attention_type: str = "default",
        positional_embeddings: Optional[str] = None,
        num_positional_embeddings: Optional[int] = None,
        ada_norm_continous_conditioning_embedding_dim: Optional[int] = None,
        ada_norm_bias: Optional[int] = None,
        ff_inner_dim: Optional[int] = None,
        ff_bias: bool = True,
        attention_out_bias: bool = True,
    ):
        super().__init__(
            dim=dim,
            num_attention_heads=num_attention_heads,
            attention_head_dim=attention_head_dim,
            dropout=dropout,
            cross_attention_dim=cross_attention_dim,
            activation_fn=activation_fn,
            num_embeds_ada_norm=num_embeds_ada_norm,
            attention_bias=attention_bias,
            only_cross_attention=only_cross_attention,
            double_self_attention=double_self_attention,
            upcast_attention=upcast_attention,
            norm_elementwise_affine=norm_elementwise_affine,
            norm_type=norm_type,
            norm_eps=norm_eps,
            final_dropout=final_dropout,
            attention_type=attention_type,
            positional_embeddings=positional_embeddings,
            num_positional_embeddings=num_positional_embeddings,
            ada_norm_continous_conditioning_embedding_dim=ada_norm_continous_conditioning_embedding_dim,
            ada_norm_bias=ada_norm_bias,
            ff_inner_dim=ff_inner_dim,
            ff_bias=ff_bias,
            attention_out_bias=attention_out_bias,
        )

    def forward(
        self,
        hidden_states: torch.Tensor,
        attention_mask: Optional[torch.Tensor] = None,
        encoder_hidden_states: Optional[torch.Tensor] = None,
        encoder_attention_mask: Optional[torch.Tensor] = None,
        timestep: Optional[torch.LongTensor] = None,
        cross_attention_kwargs: Dict[str, Any] = None,
        class_labels: Optional[torch.LongTensor] = None,
        added_cond_kwargs: Optional[Dict[str, torch.Tensor]] = None,
    ) -> torch.Tensor:
        """
        Forward pass with 3D attention support.

        Args:
            hidden_states: Input tensor of shape (batch * num_frames, seq_len, channels)
            attention_mask: Optional attention mask
            encoder_hidden_states: Cross-attention conditioning
            encoder_attention_mask: Optional cross-attention mask
            timestep: Timestep embeddings
            cross_attention_kwargs: Additional kwargs, should contain 'num_frames' for 3D attention
            class_labels: Class conditioning
            added_cond_kwargs: Additional conditioning (e.g., camera embeddings)
        """
        # Extract num_frames from cross_attention_kwargs
        num_frames = 1
        if cross_attention_kwargs is not None:
            num_frames = cross_attention_kwargs.get("num_frames", 1)
            cross_attention_kwargs = {}

        # Only apply 3D attention if num_frames > 1
        if num_frames > 1:
            # Store original shape
            batch_frames, seq_len, channels = hidden_states.shape
            batch_size = batch_frames // num_frames

            # Reshape for 3D attention: (b*f, l, c) -> (b, f*l, c)
            # This allows each position to attend across all frames
            hidden_states = rearrange(
                hidden_states,
                "(b f) l c -> b (f l) c",
                f=num_frames,
                b=batch_size
            )

            # Apply standard transformer block (self-attention will now operate across frames)
            output = super().forward(
                hidden_states=hidden_states,
                attention_mask=attention_mask,
                encoder_hidden_states=encoder_hidden_states,
                encoder_attention_mask=encoder_attention_mask,
                timestep=timestep,
                cross_attention_kwargs=cross_attention_kwargs,
                class_labels=class_labels,
                added_cond_kwargs=added_cond_kwargs,
            )

            # Reshape back to original format: (b, f*l, c) -> (b*f, l, c)
            output = rearrange(
                output,
                "b (f l) c -> (b f) l c",
                f=num_frames,
                l=seq_len
            )

            return output
        else:
            # Standard 2D attention when num_frames == 1
            return super().forward(
                hidden_states=hidden_states,
                attention_mask=attention_mask,
                encoder_hidden_states=encoder_hidden_states,
                encoder_attention_mask=encoder_attention_mask,
                timestep=timestep,
                cross_attention_kwargs=cross_attention_kwargs,
                class_labels=class_labels,
                added_cond_kwargs=added_cond_kwargs,
            )


class Transformer2DModel3D(nn.Module):
    """
    A 3D-aware version of Transformer2DModel that uses BasicTransformerBlock3D.

    This is used to replace the standard Transformer2DModel in UNet2DConditionModel's
    attention blocks for multi-view processing.
    """

    def __init__(self, transformer_2d_model):
        """
        Initialize by wrapping an existing Transformer2DModel.

        Args:
            transformer_2d_model: An instance of diffusers.models.transformers.Transformer2DModel
        """
        super().__init__()

        # Copy all attributes from the original model
        self.num_attention_heads = transformer_2d_model.num_attention_heads
        self.attention_head_dim = transformer_2d_model.attention_head_dim
        self.in_channels = transformer_2d_model.in_channels
        self.out_channels = getattr(transformer_2d_model, 'out_channels', transformer_2d_model.in_channels)
        self.num_layers = transformer_2d_model.num_layers
        self.dropout = transformer_2d_model.config.dropout
        self.norm_num_groups = transformer_2d_model.norm_num_groups
        self.cross_attention_dim = transformer_2d_model.config.cross_attention_dim
        self.attention_bias = transformer_2d_model.config.attention_bias
        self.activation_fn = transformer_2d_model.config.activation_fn
        self.norm_elementwise_affine = transformer_2d_model.config.norm_elementwise_affine
        self.double_self_attention = transformer_2d_model.config.double_self_attention
        self.upcast_attention = transformer_2d_model.config.upcast_attention
        self.norm_type = transformer_2d_model.config.norm_type
        self.use_linear_projection = transformer_2d_model.config.get('use_linear_projection', False)

        # Copy the norm layer
        self.norm = transformer_2d_model.norm

        # Copy projection layers
        self.proj_in = transformer_2d_model.proj_in

        # Replace transformer blocks with 3D versions
        # The original blocks are in transformer_2d_model.transformer_blocks
        self.transformer_blocks = nn.ModuleList()
        for block in transformer_2d_model.transformer_blocks:
            # Create a new 3D block with the same configuration
            block_3d = BasicTransformerBlock3D(
                dim=block.dim,
                num_attention_heads=block.num_attention_heads,
                attention_head_dim=block.attention_head_dim,
                dropout=self.dropout,
                cross_attention_dim=self.cross_attention_dim,
                activation_fn=self.activation_fn,
                attention_bias=self.attention_bias,
                only_cross_attention=block.only_cross_attention,
                double_self_attention=self.double_self_attention,
                upcast_attention=self.upcast_attention,
                norm_elementwise_affine=self.norm_elementwise_affine,
                norm_type=self.norm_type,
            )

            # Copy weights from the original block
            block_3d.load_state_dict(block.state_dict(), strict=True)

            self.transformer_blocks.append(block_3d)

        # Copy projection out
        self.proj_out = transformer_2d_model.proj_out

    def forward(
        self,
        hidden_states: torch.Tensor,
        encoder_hidden_states: Optional[torch.Tensor] = None,
        timestep: Optional[torch.LongTensor] = None,
        added_cond_kwargs: Optional[Dict[str, torch.Tensor]] = None,
        class_labels: Optional[torch.LongTensor] = None,
        cross_attention_kwargs: Optional[Dict[str, Any]] = None,
        attention_mask: Optional[torch.Tensor] = None,
        encoder_attention_mask: Optional[torch.Tensor] = None,
        return_dict: bool = True,
    ):
        """
        Forward pass matching Transformer2DModel's interface.
        """
        # Get input shape
        batch, channel, height, width = hidden_states.shape

        # Norm and project in
        residual = hidden_states
        hidden_states = self.norm(hidden_states)

        if not self.use_linear_projection:
            hidden_states = self.proj_in(hidden_states)
            inner_dim = hidden_states.shape[1]
            hidden_states = hidden_states.permute(0, 2, 3, 1).reshape(batch, height * width, inner_dim)
        else:
            inner_dim = hidden_states.shape[1]
            hidden_states = hidden_states.permute(0, 2, 3, 1).reshape(batch, height * width, inner_dim)
            hidden_states = self.proj_in(hidden_states)

        # Apply transformer blocks
        for block in self.transformer_blocks:
            hidden_states = block(
                hidden_states,
                attention_mask=attention_mask,
                encoder_hidden_states=encoder_hidden_states,
                encoder_attention_mask=encoder_attention_mask,
                timestep=timestep,
                cross_attention_kwargs=cross_attention_kwargs,
                class_labels=class_labels,
                added_cond_kwargs=added_cond_kwargs,
            )

        # Project out
        if self.use_linear_projection:
            hidden_states = self.proj_out(hidden_states)
            hidden_states = hidden_states.reshape(batch, height, width, inner_dim).permute(0, 3, 1, 2).contiguous()
        else:
            hidden_states = self.proj_out(hidden_states)
            hidden_states = hidden_states.reshape(batch, height, width, inner_dim).permute(0, 3, 1, 2).contiguous()

        # Add residual
        output = hidden_states + residual

        if not return_dict:
            return (output,)

        # Return in the format expected by diffusers
        from diffusers.models.transformers.transformer_2d import Transformer2DModelOutput
        return Transformer2DModelOutput(sample=output)