import logging
import os
from typing import List, Optional

import torch
import yaml
from diffusers import FlowMatchEulerDiscreteScheduler
from huggingface_hub import snapshot_download
from safetensors.torch import load_file

from .models.embedders import (
    ConditionerWrapper,
    LatentsConcatEmbedder,
    LatentsConcatEmbedderConfig,
    ConcatEmbedder,
    ConcatEmbedderConfig,
)
from .models.lbm import LBMConfig, LBMModel
from .models.unets import DiffusersUNet2DCondMVDreamWrapper
from .models.vae import AutoencoderKLDiffusers, AutoencoderKLDiffusersConfig


def get_model(
    model_dir: str,
    save_dir: Optional[str] = None,
    torch_dtype: torch.dtype = torch.bfloat16,
    device: str = "cuda",
) -> LBMModel:
    """Download the model from the model directory using either a local path or a path to HuggingFace Hub

    Args:
        model_dir (str): The path to the model directory containing the model weights and config, can be a local path or a path to HuggingFace Hub
        save_dir (Optional[str]): The local path to save the model if downloading from HuggingFace Hub. Defaults to None.
        torch_dtype (torch.dtype): The torch dtype to use for the model. Defaults to torch.bfloat16.
        device (str): The device to use for the model. Defaults to "cuda".

    Returns:
        LBMModel: The loaded model
    """
    if not os.path.exists(model_dir):
        local_dir = snapshot_download(
            model_dir,
            local_dir=save_dir,
        )
        model_dir = local_dir

    model_files = os.listdir(model_dir)

    # check yaml config file is present
    yaml_file = [f for f in model_files if f.endswith(".yaml")]
    if len(yaml_file) == 0:
        raise ValueError("No yaml file found in the model directory.")

    # check safetensors weights file is present
    safetensors_files = sorted([f for f in model_files if f.endswith(".safetensors")])
    ckpt_files = sorted([f for f in model_files if f.endswith(".ckpt")])
    if len(safetensors_files) == 0 and len(ckpt_files) == 0:
        raise ValueError("No safetensors or ckpt file found in the model directory")

    if len(model_files) == 0:
        raise ValueError("No model files found in the model directory")

    with open(os.path.join(model_dir, yaml_file[0]), "r") as f:
        config = yaml.safe_load(f)

    # The released config still asks for the LPIPS training loss, which would
    # download VGG weights at load time. Inference never uses it.
    config["pixel_loss_weight"] = 0.0
    model = _get_model_from_config(**config, torch_dtype=torch_dtype)

    if len(safetensors_files) > 0:
        logging.info(f"Loading safetensors file: {safetensors_files[-1]}")
        sd = load_file(os.path.join(model_dir, safetensors_files[-1]))
        model.load_state_dict(sd, strict=True)
    elif len(ckpt_files) > 0:
        logging.info(f"Loading ckpt file: {ckpt_files[-1]}")
        sd = torch.load(
            os.path.join(model_dir, ckpt_files[-1]),
            map_location="cpu",
            weights_only=False, 
        )["state_dict"]
        sd = {k[6:]: v for k, v in sd.items() if k.startswith("model.")}
        model.load_state_dict(
            sd,
            strict=True,
        )
    model.to(device).to(torch_dtype)

    model.eval()
    model.requires_grad_(False)

    return model


def _get_model_from_config(
    backbone_signature: str = "stabilityai/stable-diffusion-xl-base-1.0",
    vae_num_channels: int = 4,
    unet_input_channels: int = 5,
    unet_output_channels: int = 4,
    timestep_sampling: str = "log_normal",
    selected_timesteps: Optional[List[float]] = None,
    prob: Optional[List[float]] = None,
    conditioning_images_keys: Optional[List[str]] = [],
    conditioning_masks_keys: Optional[List[str]] = [],
    source_key: str = "source_image",
    target_key: str = "source_image_paste",
    bridge_noise_sigma: float = 0.0,
    logit_mean: float = 0.0,
    logit_std: float = 1.0,
    pixel_loss_type: str = "lpips",
    latent_loss_type: str = "l2",
    latent_loss_weight: float = 1.0,
    pixel_loss_weight: float = 0.0,
    torch_dtype: torch.dtype = torch.bfloat16,
    **kwargs,
):

    conditioners = []

    denoiser = DiffusersUNet2DCondMVDreamWrapper(
        in_channels=unet_input_channels,  # Add downsampled_image
        out_channels=unet_output_channels,
        use_3d_attention=True,
        num_frames=2,
        use_camera_embedding=False,
        center_input_sample=False,
        flip_sin_to_cos=True,
        freq_shift=0,
        down_block_types=[
            "DownBlock2D",
            "CrossAttnDownBlock2D",
            "CrossAttnDownBlock2D",
        ],
        mid_block_type="UNetMidBlock2DCrossAttn",
        up_block_types=["CrossAttnUpBlock2D", "CrossAttnUpBlock2D", "UpBlock2D"],
        only_cross_attention=False,
        block_out_channels=[320, 640, 1280],
        layers_per_block=2,
        downsample_padding=1,
        mid_block_scale_factor=1,
        dropout=0.0,
        act_fn="silu",
        norm_num_groups=32,
        norm_eps=1e-05,
        cross_attention_dim=[320, 640, 1280],
        transformer_layers_per_block=[1, 2, 10],
        reverse_transformer_layers_per_block=None,
        encoder_hid_dim=None,
        encoder_hid_dim_type=None,
        attention_head_dim=[5, 10, 20],
        num_attention_heads=None,
        dual_cross_attention=False,
        use_linear_projection=True,
        class_embed_type=None,
        addition_embed_type=None,
        addition_time_embed_dim=None,
        num_class_embeds=None,
        upcast_attention=None,
        resnet_time_scale_shift="default",
        resnet_skip_time_act=False,
        resnet_out_scale_factor=1.0,
        time_embedding_type="positional",
        time_embedding_dim=None,
        time_embedding_act_fn=None,
        timestep_post_act=None,
        time_cond_proj_dim=None,
        conv_in_kernel=3,
        conv_out_kernel=3,
        projection_class_embeddings_input_dim=None,
        attention_type="default",
        class_embeddings_concat=False,
        mid_block_only_cross_attention=None,
        cross_attention_norm=None,
        addition_embed_type_num_heads=64,
    ).to(torch.bfloat16)

    if conditioning_images_keys != [] or conditioning_masks_keys != []:
        # if both are lists
        if isinstance(conditioning_images_keys, list) and isinstance(conditioning_masks_keys, list):
            latents_concat_embedder_config = ConcatEmbedderConfig(
                image_keys=conditioning_images_keys,
                mask_keys=conditioning_masks_keys,
            )
            latent_concat_embedder = ConcatEmbedder(latents_concat_embedder_config)
            latent_concat_embedder.freeze()
            conditioners.append(latent_concat_embedder)
        
        elif isinstance(conditioning_images_keys, dict):
            logging.info(f"More than one conditioning type: {conditioning_images_keys.keys()}")
            
            conditioner_mapping = {"ConcatEmbedder": (ConcatEmbedder, ConcatEmbedderConfig),
                                   "LatentsConcatEmbedder": (LatentsConcatEmbedder, LatentsConcatEmbedderConfig)}

            for cond_obj_name in conditioning_images_keys.keys():
                conditioning_image_keys = conditioning_images_keys[cond_obj_name]
                conditioning_mask_keys = conditioning_masks_keys.get(cond_obj_name, []) if isinstance(conditioning_masks_keys, dict) else conditioning_masks_keys

                # Get the classes from mapping
                if cond_obj_name not in conditioner_mapping:
                    raise ValueError(f"Unknown conditioner type: {cond_obj_name}")
        
                embedder_class, config_class = conditioner_mapping[cond_obj_name]

                # Create config and embedder
                embedder_config = config_class(
                    image_keys=conditioning_image_keys,
                    mask_keys=conditioning_mask_keys,
                )
                embedder = embedder_class(embedder_config)
                embedder.freeze()
                conditioners.append(embedder)

    # Wrap conditioners and set to device
    conditioner = ConditionerWrapper(
        conditioners=conditioners,
    )

    ## VAE ##
    # Get VAE model
    vae_config = AutoencoderKLDiffusersConfig(
        version=backbone_signature,
        subfolder="vae",
        tiling_size=(128, 128),
    )
    vae = AutoencoderKLDiffusers(vae_config).to(torch_dtype)
    vae.freeze()
    vae.to(torch_dtype)

    ## Diffusion Model ##
    # Get diffusion model
    config = LBMConfig(
        source_key=source_key,
        target_key=target_key,
        latent_loss_weight=latent_loss_weight,
        latent_loss_type=latent_loss_type,
        pixel_loss_type=pixel_loss_type,
        pixel_loss_weight=pixel_loss_weight,
        timestep_sampling=timestep_sampling,
        logit_mean=logit_mean,
        logit_std=logit_std,
        selected_timesteps=selected_timesteps,
        prob=prob,
        bridge_noise_sigma=bridge_noise_sigma,
    )

    sampling_noise_scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(
        backbone_signature,
        subfolder="scheduler",
    )

    model = LBMModel(
        config,
        denoiser=denoiser,
        sampling_noise_scheduler=sampling_noise_scheduler,
        vae=vae,
        conditioner=conditioner,
    ).to(torch_dtype)

    return model
